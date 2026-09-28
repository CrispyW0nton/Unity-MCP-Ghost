using NUnit.Framework;
using UnityEngine;
namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class ObjectIdentityTests
    {
        [Test] public void HandlesSurviveCollectionAndReenumeration()
        {
            int handle = new GameObject("identity-gc").GetGhostInstanceId();
            System.GC.Collect(); System.GC.WaitForPendingFinalizers(); System.GC.Collect();
            var resolved = ObjectIdentity.Resolve(handle);
            try { Assert.IsTrue(resolved != null); Assert.AreEqual("identity-gc", resolved.name); Assert.AreEqual(handle, resolved.GetGhostInstanceId()); }
            finally { if (resolved != null) Object.DestroyImmediate(resolved); }
        }
        [Test] public void HandlesResolveExactObjectsAndRejectDestroyedObjects()
        {
            var a = new GameObject("identity-a"); var b = new GameObject("identity-b");
            try
            {
                int ah = a.GetGhostInstanceId(), bh = b.GetGhostInstanceId();
                Assert.AreEqual(ah, a.GetGhostInstanceId()); Assert.AreNotEqual(ah,bh);
                Assert.AreSame(a,ObjectIdentity.Resolve(ah)); Assert.AreSame(b,ObjectIdentity.Resolve(bh));
                Object.DestroyImmediate(a); Assert.IsTrue(ObjectIdentity.Resolve(ah)==null);
            }
            finally { if(a!=null)Object.DestroyImmediate(a); Object.DestroyImmediate(b); }
        }
    }
}
