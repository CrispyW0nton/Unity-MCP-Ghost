using System.Collections.Generic;
using NUnit.Framework;

namespace CrispyWonton.UnityMcpGhost.Editor.Tests
{
    public sealed class OperationCatalogParityTests
    {
        [Test]
        public void EveryGeneratedDirectBridgeOperationHasAHandler()
        {
            var registry = new CommandRegistry();
            var registered = new HashSet<string>(registry.RegisteredMethods);

            Assert.That(GeneratedOperationCatalog.Version, Is.EqualTo(1));
            Assert.That(GeneratedOperationCatalog.DirectBridgeOperations.Length, Is.GreaterThanOrEqualTo(50));
            foreach (var operation in GeneratedOperationCatalog.DirectBridgeOperations)
            {
                Assert.That(registered.Contains(operation), Is.True, "Missing C# handler for generated operation " + operation);
            }
        }
    }
}
