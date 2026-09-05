using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class HttpRequestBodyTimeoutTests
    {
        [Test]
        public void BoundedBodyReadHonorsCancellation()
        {
            using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50)))
            using (var stream = new BlockingReadStream())
            {
                Exception observed = null;
                try
                {
                    Task.Run(() => UnityMcpGhostServer.ReadBoundedRequest(stream, Encoding.UTF8, cancellation.Token))
                        .GetAwaiter()
                        .GetResult();
                }
                catch (Exception exception)
                {
                    observed = exception;
                }
                Assert.That(observed, Is.InstanceOf<OperationCanceledException>());
            }
        }

        private sealed class BlockingReadStream : Stream
        {
            public override bool CanRead => true;
            public override bool CanSeek => false;
            public override bool CanWrite => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override void Flush() { }
            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            {
                await Task.Delay(Timeout.Infinite, cancellationToken);
                return 0;
            }
        }
    }
}
