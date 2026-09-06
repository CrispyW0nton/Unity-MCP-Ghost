import { spawn, type ChildProcess } from "node:child_process";

export interface WindowsVersionJob {
  /** The supervisor, whose lifetime is independent of the version executable. */
  child: ChildProcess;
  output: Promise<string>;
  stop: () => Promise<void>;
}

/**
 * Windows 10+ / PowerShell 7. The fixed supervisor source travels with compiled
 * JS, so packaged runners do not need a loose script or native addon. Executable
 * paths and arguments travel as JSON data, never as PowerShell source.
 */
export function startWindowsVersionJob(path: string, args: string[]): WindowsVersionJob {
  if (path.includes("\0") || args.some((argument) => argument.includes("\0"))) throw new Error("Version executable and arguments must not contain null bytes.");
  const command = [
    '$ErrorActionPreference = "Stop"',
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$request = [Console]::In.ReadLine() | ConvertFrom-Json",
    "Add-Type -TypeDefinition $request.source",
    "[GhostVersionJob]::Run([string]$request.path, [string[]]$request.arguments)"
  ].join("; ");
  const child = spawn("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let resolveOutput!: (output: string) => void;
  let rejectOutput!: (error: unknown) => void;
  const output = new Promise<string>((resolve, reject) => {
    resolveOutput = resolve;
    rejectOutput = reject;
  });
  // Observation can be cancelled before startup completes. Keep late failures
  // handled, while stop() still checks the owner's independent cleanup proof.
  void output.catch(() => {});
  let ownerFailure: unknown;
  let cleaned = false;
  let resultSeen = false;
  let pending = "";
  let protocolBytes = 0;
  let diagnostics = "";
  let inputFailure: unknown;
  const failOwner = (error: unknown) => {
    ownerFailure ??= error;
    rejectOutput(error);
  };
  child.on("error", failOwner);
  // The supervisor can finish and close its input while our stop command is in
  // flight. Its completion proof decides cleanup, not that benign pipe race.
  child.stdin!.on("error", (error) => {
    inputFailure = error;
  });
  child.stdout!.on("error", failOwner);
  child.stderr!.on("error", failOwner);
  child.stdout!.on("data", (chunk: Buffer) => {
    protocolBytes += chunk.byteLength;
    if (protocolBytes > 16384) {
      failOwner(ownerError("Supervisor protocol exceeded its byte limit."));
      return;
    }
    pending += chunk.toString("utf8");
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const message = JSON.parse(line) as { kind?: string; code?: string | number; message?: string; output?: string };
        if (message.kind === "cleaned") cleaned = true;
        else if (message.kind === "error" && typeof message.code === "string" && typeof message.message === "string") {
          const error = Object.assign(new Error(`${message.code}: ${message.message}`), { code: message.code });
          if (message.code === "UNITY_VERSION_OWNER_FAILED") failOwner(error);
          else rejectOutput(error);
        } else if (message.kind === "result" && Number.isInteger(message.code) && typeof message.output === "string" && !resultSeen) {
          resultSeen = true;
          if (message.code !== 0) {
            rejectOutput(
              Object.assign(new Error(`UNITY_VERSION_EXIT_FAILED: Version probe exited with code ${message.code}.`), { code: "UNITY_VERSION_EXIT_FAILED" })
            );
          } else resolveOutput(Buffer.from(message.output, "base64").toString("utf8"));
        } else failOwner(ownerError("Unexpected supervisor protocol message."));
      } catch (error) {
        failOwner(ownerError("Invalid supervisor protocol.", error));
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    // Diagnostics are separate from the version executable's bounded stderr.
    diagnostics = (diagnostics + chunk.toString("utf8")).slice(0, 4096);
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", (code) => {
      if (code !== 0 || pending.trim()) failOwner(ownerError(`Supervisor exited without a valid completion (code ${code}). ${diagnostics}`, inputFailure));
      rejectOutput(ownerError("Supervisor ended before a complete version result."));
      resolve();
    });
  });
  child.stdin!.write(`${JSON.stringify({ source: supervisorSource, path, arguments: args })}\n`);
  let stopping: Promise<void> | undefined;
  return {
    child,
    output,
    stop: () => (stopping ??= stop())
  };

  async function stop(): Promise<void> {
    if (child.exitCode === null && child.signalCode === null && !child.stdin!.destroyed) child.stdin!.end("stop\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(ownerError("Supervisor did not verify job cleanup within 15000 ms.")), 15000);
        })
      ]);
    } catch (error) {
      // Last-handle-close is a fail-safe, not proof. Preserve the uncertainty
      // even if killing the supervisor triggers the kernel's job teardown.
      failOwner(error);
      child.kill("SIGKILL");
      clearTimeout(timer);
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        })
      ]);
    } finally {
      clearTimeout(timer);
      child.stdin!.destroy();
      child.stdout!.destroy();
      child.stderr!.destroy();
    }
    if (ownerFailure) throw ownerFailure;
    if (!cleaned) throw ownerError("Supervisor did not prove that its job was empty.", inputFailure);
  }
}

function ownerError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(`UNITY_VERSION_OWNER_FAILED: ${message}`, { cause }), { code: "UNITY_VERSION_OWNER_FAILED" });
}

// Clean-room Win32 interop. JOB_LIST assigns the process before its first
// instruction; HANDLE_LIST prevents it inheriting the non-inheritable job handle.
// No BREAKAWAY flags are enabled. The job remains owned after the root exits.
// API contracts: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
// https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
const supervisorSource = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class GhostVersionJob {
  [StructLayout(LayoutKind.Sequential)] struct Security {
    public int length; public IntPtr descriptor; public int inherit;
  }
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public int size; public IntPtr reserved, desktop, title;
    public uint x, y, width, height, xChars, yChars, fill, flags;
    public ushort show, reservedSize; public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minWorking, maxWorking; public uint activeLimit;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long userTime, kernelTime, periodUserTime, periodKernelTime;
    public uint faults, total, active, terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string path, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
  static void Emit(object value) { Console.Out.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
  static void Failure(string code, Exception error) {
    string message = error.GetBaseException().Message;
    Emit(new { kind = "error", code, message = message.Substring(0, Math.Min(1024, message.Length)) });
  }

  // CreateProcess receives a mutable CRT-quoted command line, never shell text.
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', 2 * slashes + 1); result.Append(c); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', 2 * slashes); result.Append('"'); return result.ToString();
  }

  sealed class OutputLimit : Exception { public OutputLimit(string stream) : base("Version probe " + stream + " exceeded 4096 bytes.") {} }
  static Task<byte[]> ReadOutput(ref IntPtr reader, string stream) {
    var owned = new SafeFileHandle(reader, true);
    reader = IntPtr.Zero;
    return Task.Run(() => {
      using (owned)
      using (var input = new FileStream(owned, FileAccess.Read))
      using (var output = new MemoryStream()) {
        var buffer = new byte[1024];
        int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
          if (output.Length + count > 4096) throw new OutputLimit(stream);
          output.Write(buffer, 0, count);
        }
        return output.ToArray();
      }
    });
  }

  public static void Run(string path, string[] arguments) {
    IntPtr job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
    IntPtr errRead = IntPtr.Zero, errWrite = IntPtr.Zero, inRead = IntPtr.Zero, inWrite = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo();
    // EOF also means stop: an abruptly lost Node caller must not strand a job.
    var stop = Task.Run(() => Console.In.ReadLine());
    try {
      job = CreateJobObjectW(IntPtr.Zero, null);
      Check(job != IntPtr.Zero);
      var limits = new ExtendedLimits();
      limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE only.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()));
      var security = new Security { length = Marshal.SizeOf<Security>(), inherit = 1 };
      Check(CreatePipe(out outRead, out outWrite, ref security, 0));
      Check(CreatePipe(out errRead, out errWrite, ref security, 0));
      Check(CreatePipe(out inRead, out inWrite, ref security, 0));
      Check(SetHandleInformation(outRead, 1, 0));
      Check(SetHandleInformation(errRead, 1, 0));
      Close(ref inWrite); // Target stdin is EOF, not the supervisor's control pipe.
      if (stop.IsCompleted) return;

      IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero, size = IntPtr.Zero;
      bool initialized = false;
      try {
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        attributes = Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
        initialized = true;
        jobs = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(jobs, job);
        Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000D, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));
        handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
        Marshal.WriteIntPtr(handles, 0, inRead);
        Marshal.WriteIntPtr(handles, IntPtr.Size, outWrite);
        Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, errWrite);
        Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x20002, handles, (IntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
        var startup = new StartupEx { attributes = attributes };
        startup.startup.size = Marshal.SizeOf<StartupEx>();
        startup.startup.flags = 0x101; // USESTDHANDLES | USESHOWWINDOW; SW_HIDE.
        startup.startup.input = inRead; startup.startup.output = outWrite; startup.startup.error = errWrite;
        var command = new StringBuilder(Quote(path));
        foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
        // Atomic membership: never create a running or suspended process first
        // and assign it afterwards. Neither target nor helper can escape that gap.
        Check(CreateProcessW(path, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, null, ref startup, out process));
      } finally {
        if (initialized) DeleteProcThreadAttributeList(attributes);
        if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
        if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
        if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      }
      Close(ref process.thread); Close(ref inRead); Close(ref outWrite); Close(ref errWrite);
      var stdout = ReadOutput(ref outRead, "stdout");
      var stderr = ReadOutput(ref errRead, "stderr");
      while (!stop.IsCompleted) {
        if (stdout.IsFaulted) throw stdout.Exception.GetBaseException();
        if (stderr.IsFaulted) throw stderr.Exception.GetBaseException();
        uint waited = WaitForSingleObject(process.process, 0);
        if (waited == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (waited == 0 && stdout.IsCompleted && stderr.IsCompleted) {
          uint code; Check(GetExitCodeProcess(process.process, out code));
          Emit(new { kind = "result", code, output = Convert.ToBase64String(stdout.Result) });
          break;
        }
        Thread.Sleep(10);
      }
    } catch (Exception error) {
      Failure(error is OutputLimit ? "UNITY_VERSION_OUTPUT_LIMIT" : "UNITY_VERSION_PROBE_FAILED", error);
    } finally {
      Close(ref process.thread); Close(ref process.process);
      Close(ref inRead); Close(ref inWrite); Close(ref outWrite); Close(ref errWrite);
      Close(ref outRead); Close(ref errRead);
      try {
        if (job == IntPtr.Zero) throw new Exception("No job handle was established.");
        Check(TerminateJobObject(job, 1));
        var deadline = Stopwatch.StartNew();
        while (true) {
          Accounting accounting;
          Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
          if (accounting.active == 0) break;
          if (deadline.ElapsedMilliseconds >= 10000) throw new Exception("Job did not become empty within 10000 ms.");
          Thread.Sleep(10);
        }
        Emit(new { kind = "cleaned" });
      } catch (Exception error) { Failure("UNITY_VERSION_OWNER_FAILED", error); }
      finally { Close(ref job); }
    }
  }
}
`;
