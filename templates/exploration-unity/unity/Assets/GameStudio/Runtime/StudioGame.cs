using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace GameStudio
{
    // Starts the game from the studio's data: builds the level, places the player and runs the game
    // rules Game Studio compiles (objectives, dialogue, gates; see StudioRules). Picking up collectibles,
    // walking into zones and pressing E near a person or sign are the events the rules hear.
    //   --studio-smoke      headless self-test (SmokeTest.cs)
    //   --studio-telemetry  prints one GSTUDIO line (JSON) per rule run for Game Studio's run console
    public class StudioGame : MonoBehaviour
    {
        public WorldData World { get; private set; }
        public string LoadError { get; private set; } = "";
        public WorldBuilder Builder { get; private set; }
        public StudioPlayer Player { get; private set; }
        public StudioRules Rules { get; private set; }
        public StudioSounds Sounds { get; private set; }
        public readonly Dictionary<string, string> Collected = new Dictionary<string, string>();
        public readonly HashSet<string> ZonesEntered = new HashSet<string>();
        public readonly List<string> MessagesShown = new List<string>();
        public readonly List<string> Errors = new List<string>();
        public string Objective = "";
        public string WinText;
        public bool Won => WinText != null;
        // The person or sign the player can use with E, or null.
        public string Focus { get; private set; }

        const string Help = "W A S D move   Shift sprint   Space jump   right mouse button look   E talk or read";
        readonly Queue<KeyValuePair<string, float>> queue = new Queue<KeyValuePair<string, float>>();
        readonly HashSet<string> insideZones = new HashSet<string>();
        string message;
        float messageTime;

        void Awake()
        {
            Application.SetStackTraceLogType(LogType.Log, StackTraceLogType.None);
            Application.SetStackTraceLogType(LogType.Warning, StackTraceLogType.None);
            Application.logMessageReceived += OnLog;
            if (Application.isBatchMode) Application.targetFrameRate = 60;
            var args = new List<string>(System.Environment.GetCommandLineArgs());
            World = StudioData.LoadWorld(out string error);
            LoadError = error;
            Builder = new WorldBuilder(new GameObject("level").transform);
            if (World != null)
            {
                Builder.Build(World);
                ApplyEnvironment(World.environment);
            }
            SpawnPlayer();
            Sounds = gameObject.AddComponent<StudioSounds>();
            Rules = new StudioRules(this, args.Contains("--studio-telemetry"));
            Rules.Load();
            var ids = new List<object>();
            foreach (StudioRules.Program p in Rules.Programs) ids.Add(p.Id);
            Rules.Emit(new Dictionary<string, object> { { "type", "ready" }, { "programs", ids }, { "worldError", LoadError }, { "ruleErrors", new List<string>(Rules.Errors) } });
            Rules.Fire("start", new Dictionary<string, object>());
            if (args.Contains("--studio-smoke")) gameObject.AddComponent<SmokeTest>().Begin(this);
        }

        void OnDestroy() => Application.logMessageReceived -= OnLog;

        void OnLog(string text, string stack, LogType type)
        {
            if (type == LogType.Error || type == LogType.Exception || type == LogType.Assert) Errors.Add(text);
        }

        void ApplyEnvironment(EnvironmentData env)
        {
            Color horizon = StudioData.ParseColor(env.skyHorizon, new Color(0.72f, 0.83f, 0.93f));
            Color ground = StudioData.ParseColor(env.ground, new Color(0.35f, 0.49f, 0.24f));
            var sun = new GameObject("sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.intensity = 1.1f;
            sun.color = StudioData.ParseColor(env.sunColor, Color.white);
            sun.shadows = LightShadows.Soft;
            sun.transform.rotation = Quaternion.Euler(env.sunElevation, env.sunHeading, 0f);
            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = Color.Lerp(horizon, ground, 0.35f) * 0.75f;
            RenderSettings.fog = env.fogDensity > 0f;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogDensity = env.fogDensity;
            RenderSettings.fogColor = horizon;
        }

        void SpawnPlayer()
        {
            var camera = new GameObject("camera").AddComponent<Camera>();
            camera.tag = "MainCamera";
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = StudioData.ParseColor(World?.environment.skyHorizon, new Color(0.72f, 0.83f, 0.93f));
            camera.gameObject.AddComponent<AudioListener>();

            GameObject body = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            body.name = "player";
            Object.Destroy(body.GetComponent<Collider>());
            StudioData.Paint(body.GetComponent<Renderer>(), new Color(0.85f, 0.42f, 0.25f));
            var controller = body.AddComponent<CharacterController>();
            controller.height = 2f;
            controller.radius = 0.45f;
            controller.center = Vector3.zero;
            Player = body.AddComponent<StudioPlayer>();
            PlayerData p = World != null ? World.player : new PlayerData();
            Player.speed = p.speed;
            Player.sprintMultiplier = p.sprintMultiplier;
            Player.jumpVelocity = p.jumpVelocity;
            Player.cameraDistance = p.cameraDistance;
            Player.SpawnPoint = StudioData.ToUnity(p.spawn.x, p.spawn.z, 1.2f);
            Player.Init(camera.transform);
            Player.Teleport(Player.SpawnPoint);
        }

        // ---- What the rules can do (StudioRules calls these) ----------------------------------

        public void ShowMessage(string text, float seconds)
        {
            MessagesShown.Add(text);
            queue.Enqueue(new KeyValuePair<string, float>(text, Mathf.Max(seconds, 0.5f)));
            if (message == null) NextMessage();
        }

        void NextMessage()
        {
            if (queue.Count == 0)
            {
                message = null;
                return;
            }
            KeyValuePair<string, float> item = queue.Dequeue();
            message = item.Key;
            messageTime = item.Value;
        }

        public void ShowWin(string text) => WinText = text;

        public bool SetObjectVisible(string id, bool visible)
        {
            if (!Builder.Nodes.TryGetValue(id, out GameObject node)) return false;
            node.SetActive(visible);
            return true;
        }

        public int CollectedCount(string kind)
        {
            int count = 0;
            foreach (string k in Collected.Values) if (k == kind) count++;
            return count;
        }

        public int TotalCount(string kind)
        {
            int count = 0;
            if (World != null) foreach (WorldObjectData o in World.objects) if (o != null && o.type == "collectible" && KindOf(o) == kind) count++;
            return count;
        }

        static string KindOf(WorldObjectData o) => string.IsNullOrEmpty(o.kind) ? "crystal" : o.kind;

        // ---- Events -------------------------------------------------------------------------

        public bool Collect(string id)
        {
            if (Collected.ContainsKey(id) || !Builder.Nodes.TryGetValue(id, out GameObject node) || Builder.Objects[id].type != "collectible") return false;
            string kind = KindOf(Builder.Objects[id]);
            Collected[id] = kind;
            node.SetActive(false);
            Rules.Fire("collect", new Dictionary<string, object> { { "itemId", id }, { "kind", kind } });
            return true;
        }

        // Talks to the person or reads the sign in reach (what E does).
        public bool Interact()
        {
            if (Focus == null) return false;
            WorldObjectData o = Builder.Objects[Focus];
            if (o.type == "sign") ShowMessage(o.text ?? "", 6f);
            Rules.Fire("interact", new Dictionary<string, object> { { "targetId", Focus } });
            return true;
        }

        string FindFocus(Vector3 p)
        {
            string best = null;
            float bestDistance = float.MaxValue;
            foreach (var pair in Builder.Objects)
            {
                WorldObjectData o = pair.Value;
                float reach = o.type == "npc" ? 2.6f : o.type == "sign" ? 2.4f : 0f;
                if (reach == 0f || !Builder.Nodes[pair.Key].activeInHierarchy) continue;
                float d = Vector3.Distance(p, StudioData.ToUnity(o.x, o.z));
                if (d <= reach && d < bestDistance)
                {
                    best = pair.Key;
                    bestDistance = d;
                }
            }
            return best;
        }

        static string Prompt(WorldObjectData o) => o.type == "npc" ? "Talk to " + (string.IsNullOrEmpty(o.name) ? "Villager" : o.name) : "Read the sign";

        void Update()
        {
            if (message != null)
            {
                messageTime -= Time.deltaTime;
                if (messageTime <= 0f) NextMessage();
            }
            if (Player == null || World == null) return;
            Vector3 p = Player.transform.position;
            foreach (var pair in Builder.Objects)
            {
                WorldObjectData o = pair.Value;
                if (!Builder.Nodes[pair.Key].activeInHierarchy) continue;
                Vector3 at = StudioData.ToUnity(o.x, o.z);
                float flat = new Vector2(p.x - at.x, p.z - at.z).magnitude;
                if (o.type == "collectible" && flat < 1.3f && Mathf.Abs(p.y - 1f) < 2f) Collect(o.id);
                else if (o.type == "zone")
                {
                    // Like a Godot Area3D: the event fires each time the player walks in.
                    if (flat > o.radius) insideZones.Remove(o.id);
                    else if (insideZones.Add(o.id))
                    {
                        ZonesEntered.Add(o.id);
                        Rules.Fire("enterZone", new Dictionary<string, object> { { "zoneId", o.id } });
                    }
                }
            }
            Focus = FindFocus(p);
            if (Player.controlsEnabled && !Application.isBatchMode && Input.GetKeyDown(KeyCode.E)) Interact();
        }

        GUIStyle big;

        void OnGUI()
        {
            int total = Builder == null ? 0 : Builder.IdsOfType("collectible").Count;
            GUILayout.BeginArea(new Rect(16, 16, 560, 260), GUI.skin.box);
            GUILayout.Label(World != null ? World.name : "No level loaded");
            if (!string.IsNullOrEmpty(Objective)) GUILayout.Label(Objective);
            GUILayout.Label($"Collected {Collected.Count} of {total}");
            if (!string.IsNullOrEmpty(LoadError)) GUILayout.Label(LoadError);
            if (Rules != null) for (int i = Mathf.Max(0, Rules.Errors.Count - 3); i < Rules.Errors.Count; i++) GUILayout.Label(Rules.Errors[i]);
            GUILayout.EndArea();

            if (message != null) GUI.Box(new Rect(Screen.width / 2f - 320f, Screen.height - 150f, 640f, 56f), message);
            if (Focus != null) GUI.Label(new Rect(Screen.width / 2f - 120f, Screen.height / 2f + 40f, 400f, 24f), "E   " + Prompt(Builder.Objects[Focus]));
            GUI.Label(new Rect(16, Screen.height - 32f, 800f, 24f), Help);
            if (Won)
            {
                if (big == null) big = new GUIStyle(GUI.skin.box) { fontSize = 26, wordWrap = true, alignment = TextAnchor.MiddleCenter };
                GUI.Box(new Rect(Screen.width / 2f - 300f, Screen.height / 2f - 90f, 600f, 120f), WinText, big);
            }
        }
    }
}
