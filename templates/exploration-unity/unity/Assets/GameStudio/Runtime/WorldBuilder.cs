using System.Collections.Generic;
using UnityEngine;

namespace GameStudio
{
    public class Spinner : MonoBehaviour
    {
        public float degreesPerSecond = 90f;
        void Update() => transform.Rotate(0f, degreesPerSecond * Time.deltaTime, 0f, Space.World);
    }

    // A gate's door. Open() lets the player through at once and sinks the door into the ground over
    // 2.5 seconds, as gate.gd does in the Godot template.
    public class StudioGate : MonoBehaviour
    {
        public GameObject door;
        public bool IsOpen { get; private set; }
        float sunk;
        float startY;

        public void Open()
        {
            if (IsOpen) return;
            IsOpen = true;
            if (door == null) return;
            startY = door.transform.localPosition.y;
            Collider solid = door.GetComponent<Collider>();
            if (solid != null) solid.enabled = false;
        }

        void Update()
        {
            if (!IsOpen || door == null || sunk >= 1f) return;
            sunk = Mathf.Min(1f, sunk + Time.deltaTime / 2.5f);
            Vector3 p = door.transform.localPosition;
            p.y = startY - 4.2f * Mathf.SmoothStep(0f, 1f, sunk);
            door.transform.localPosition = p;
        }
    }

    // Builds the level from world.json out of Unity primitives. Collisions match the Godot
    // version closely enough for the self-test: trunks, rocks, people, posts and closed gates block.
    public class WorldBuilder
    {
        public readonly Dictionary<string, GameObject> Nodes = new Dictionary<string, GameObject>();
        public readonly Dictionary<string, WorldObjectData> Objects = new Dictionary<string, WorldObjectData>();
        public readonly Dictionary<string, StudioGate> Gates = new Dictionary<string, StudioGate>();
        readonly Transform root;

        public WorldBuilder(Transform root) { this.root = root; }

        public List<string> IdsOfType(string type)
        {
            var ids = new List<string>();
            foreach (var pair in Objects) if (pair.Value.type == type) ids.Add(pair.Key);
            return ids;
        }

        public void Build(WorldData world)
        {
            BuildGround(world.size, world.environment);
            foreach (WorldObjectData o in world.objects)
            {
                if (o == null || string.IsNullOrEmpty(o.id) || Nodes.ContainsKey(o.id)) continue;
                GameObject go = BuildObject(o);
                if (go == null) continue;
                Nodes[o.id] = go;
                Objects[o.id] = o;
            }
        }

        static GameObject Part(PrimitiveType type, Transform parent, Vector3 position, Vector3 scale, Color color, bool solid)
        {
            GameObject go = GameObject.CreatePrimitive(type);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = position;
            go.transform.localScale = scale;
            StudioData.Paint(go.GetComponent<Renderer>(), color);
            if (!solid) Object.Destroy(go.GetComponent<Collider>());
            return go;
        }

        void BuildGround(SizeData size, EnvironmentData env)
        {
            var ground = new GameObject("ground").transform;
            ground.SetParent(root, false);
            Part(PrimitiveType.Cube, ground, new Vector3(0f, -0.5f, 0f), new Vector3(size.width, 1f, size.depth), StudioData.ParseColor(env.ground, new Color(0.35f, 0.49f, 0.24f)), true);
            // Invisible walls along the map edge, as in the Godot version.
            float w = size.width, d = size.depth;
            Vector3[] centers = { new Vector3(0f, 3f, -d / 2f - 0.5f), new Vector3(0f, 3f, d / 2f + 0.5f), new Vector3(-w / 2f - 0.5f, 3f, 0f), new Vector3(w / 2f + 0.5f, 3f, 0f) };
            Vector3[] sizes = { new Vector3(w + 2f, 8f, 1f), new Vector3(w + 2f, 8f, 1f), new Vector3(1f, 8f, d + 2f), new Vector3(1f, 8f, d + 2f) };
            for (int i = 0; i < 4; i++)
            {
                GameObject wall = Part(PrimitiveType.Cube, ground, centers[i], sizes[i], Color.clear, true);
                wall.GetComponent<Renderer>().enabled = false;
            }
        }

        GameObject BuildObject(WorldObjectData o)
        {
            var go = new GameObject(o.id);
            Transform t = go.transform;
            t.SetParent(root, false);
            t.position = StudioData.ToUnity(o.x, o.z);
            t.rotation = StudioData.Yaw(o.rotation);
            t.localScale = Vector3.one * Mathf.Clamp(o.scale, 0.2f, 5f);
            Color bark = new Color(0.48f, 0.34f, 0.2f);
            switch (o.type)
            {
                case "tree":
                    if (o.variant == "baobab")
                    {
                        Part(PrimitiveType.Cylinder, t, new Vector3(0f, 1.5f, 0f), new Vector3(1.4f, 1.5f, 1.4f), bark, true);
                        Part(PrimitiveType.Sphere, t, new Vector3(0f, 3.4f, 0f), new Vector3(4.2f, 1.4f, 4.2f), new Color(0.36f, 0.55f, 0.25f), false);
                    }
                    else if (o.variant == "tall")
                    {
                        Part(PrimitiveType.Cylinder, t, new Vector3(0f, 1.3f, 0f), new Vector3(0.45f, 1.3f, 0.45f), bark, true);
                        Part(PrimitiveType.Capsule, t, new Vector3(0f, 4f, 0f), new Vector3(1.8f, 1.9f, 1.8f), new Color(0.2f, 0.45f, 0.24f), false);
                    }
                    else
                    {
                        Part(PrimitiveType.Cylinder, t, new Vector3(0f, 1.1f, 0f), new Vector3(0.5f, 1.1f, 0.5f), bark, true);
                        Part(PrimitiveType.Sphere, t, new Vector3(0f, 3.1f, 0f), new Vector3(3f, 2.6f, 3f), new Color(0.29f, 0.53f, 0.25f), false);
                    }
                    break;
                case "rock":
                    Part(PrimitiveType.Sphere, t, new Vector3(0f, 0.45f, 0f), new Vector3(1.6f, 1f, 1.3f), new Color(0.54f, 0.56f, 0.59f), true);
                    break;
                case "collectible":
                    GameObject crystal = Part(PrimitiveType.Cube, t, new Vector3(0f, 1.1f, 0f), new Vector3(0.45f, 0.45f, 0.45f), new Color(0.96f, 0.77f, 0.26f), false);
                    crystal.transform.localRotation = Quaternion.Euler(45f, 0f, 45f);
                    go.AddComponent<Spinner>();
                    break;
                case "npc":
                    Color cloth = StudioData.ParseColor(o.color, new Color(0.78f, 0.53f, 0.23f));
                    Part(PrimitiveType.Capsule, t, new Vector3(0f, 0.9f, 0f), new Vector3(0.8f, 0.9f, 0.8f), cloth, true);
                    Part(PrimitiveType.Sphere, t, new Vector3(0f, 1.95f, 0f), new Vector3(0.45f, 0.45f, 0.45f), new Color(0.42f, 0.29f, 0.2f), false);
                    break;
                case "gate":
                    Color stone = new Color(0.62f, 0.55f, 0.45f);
                    float half = Mathf.Max(1f, o.width) / 2f;
                    Part(PrimitiveType.Cube, t, new Vector3(-half - 0.45f, 2.2f, 0f), new Vector3(0.9f, 4.4f, 0.9f), stone, true);
                    Part(PrimitiveType.Cube, t, new Vector3(half + 0.45f, 2.2f, 0f), new Vector3(0.9f, 4.4f, 0.9f), stone, true);
                    Part(PrimitiveType.Cube, t, new Vector3(0f, 4.6f, 0f), new Vector3(half * 2f + 1.8f, 0.5f, 1f), stone, false);
                    // Closed until a rule opens it (explore.openGate).
                    GameObject door = Part(PrimitiveType.Cube, t, new Vector3(0f, 1.6f, 0f), new Vector3(half * 2f, 3.2f, 0.3f), new Color(0.45f, 0.3f, 0.16f), true);
                    door.name = "door";
                    StudioGate gate = go.AddComponent<StudioGate>();
                    gate.door = door;
                    Gates[o.id] = gate;
                    break;
                case "zone":
                    GameObject disc = Part(PrimitiveType.Cylinder, t, new Vector3(0f, 0.02f, 0f), new Vector3(o.radius * 2f, 0.01f, o.radius * 2f) / Mathf.Max(0.2f, o.scale), new Color(0.98f, 0.86f, 0.5f), false);
                    disc.GetComponent<Renderer>().enabled = o.visible;
                    break;
                case "water":
                    Part(PrimitiveType.Cylinder, t, new Vector3(0f, 0.03f, 0f), new Vector3(o.radius * 2f, 0.02f, o.radius * 2f) / Mathf.Max(0.2f, o.scale), new Color(0.24f, 0.47f, 0.7f), false);
                    break;
                case "sign":
                    Part(PrimitiveType.Cube, t, new Vector3(0f, 0.7f, 0f), new Vector3(0.15f, 1.4f, 0.15f), bark, true);
                    Part(PrimitiveType.Cube, t, new Vector3(0f, 1.45f, 0f), new Vector3(1.4f, 0.7f, 0.1f), new Color(0.66f, 0.5f, 0.3f), false);
                    break;
                case "torch":
                    Part(PrimitiveType.Cylinder, t, new Vector3(0f, 0.6f, 0f), new Vector3(0.15f, 0.6f, 0.15f), bark, true);
                    Part(PrimitiveType.Sphere, t, new Vector3(0f, 1.35f, 0f), new Vector3(0.3f, 0.3f, 0.3f), new Color(1f, 0.6f, 0.2f), false);
                    Light flame = new GameObject("light").AddComponent<Light>();
                    flame.transform.SetParent(t, false);
                    flame.transform.localPosition = new Vector3(0f, 1.5f, 0f);
                    flame.type = LightType.Point;
                    flame.color = new Color(1f, 0.65f, 0.3f);
                    flame.range = 6f;
                    break;
                default:
                    Object.Destroy(go);
                    return null;
            }
            return go;
        }
    }
}
