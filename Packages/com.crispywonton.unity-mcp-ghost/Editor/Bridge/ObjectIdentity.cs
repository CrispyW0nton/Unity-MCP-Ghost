using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace CrispyWonton.UnityMcpGhost.Editor
{
    // Protocol instanceId is an opaque bridge handle on Unity 6.5+. EntityId's
    // representation is deliberately never cast to an integer or serialized.
    internal static class ObjectIdentity
    {
#if UNITY_6000_5_OR_NEWER
        private static readonly Dictionary<EntityId, int> Handles = new Dictionary<EntityId, int>();
        private static readonly Dictionary<int, EntityId> Objects = new Dictionary<int, EntityId>();
        private const string CounterKey = "UnityMcpGhost.ObjectHandleCounter";
#endif
        public static int GetGhostInstanceId(this UnityEngine.Object value)
        {
            if (value == null) return 0;
#if UNITY_6000_5_OR_NEWER
            EntityId entity = value.GetEntityId();
            if (Handles.TryGetValue(entity, out int known)) return known;
            int next = checked(SessionState.GetInt(CounterKey, 0) + 1);
            SessionState.SetInt(CounterKey, next);
            Handles.Add(entity, next);
            Objects.Add(next, entity);
            return next;
#else
            return value.GetInstanceID();
#endif
        }
        public static UnityEngine.Object Resolve(int handle)
        {
#if UNITY_6000_5_OR_NEWER
            return Objects.TryGetValue(handle, out var entity) ? EditorUtility.EntityIdToObject(entity) : null;
#else
            return EditorUtility.InstanceIDToObject(handle);
#endif
        }
    }
}
