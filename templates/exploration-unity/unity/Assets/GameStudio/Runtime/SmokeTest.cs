using System.Collections;
using System.Collections.Generic;
using GameStudio.Rules;
using UnityEngine;

namespace GameStudio
{
    // Headless self-test, started with:  <player> -batchmode -nographics -logFile - --studio-smoke
    // Checks loading, physics, walking, talking, collecting, zones and rule errors, then prints one line
    // starting with GSTUDIO_SMOKE (JSON) and quits with 0 on success, 1 on failure. Level-specific
    // outcomes (objective, gates, win) go under "observations" for the caller to judge, as in smoke_test.gd.
    public class SmokeTest : MonoBehaviour
    {
        readonly List<object> checks = new List<object>();
        bool failed;
        StudioGame game;

        public void Begin(StudioGame target)
        {
            game = target;
            StartCoroutine(Run());
        }

        void Add(string name, bool ok, string detail = "")
        {
            checks.Add(new Dictionary<string, object> { { "name", name }, { "ok", ok }, { "detail", detail } });
            if (!ok) failed = true;
        }

        IEnumerator Seconds(float s)
        {
            float end = Time.time + s;
            while (Time.time < end) yield return null;
        }

        IEnumerator Run()
        {
            yield return null;
            int expected = game.World != null ? game.World.objects.Length : -1;
            Add("level data loads", game.World != null && string.IsNullOrEmpty(game.LoadError), game.LoadError);
            Add("every object is built", game.Builder.Nodes.Count == expected, $"{game.Builder.Nodes.Count} of {expected}");
            Add("rule programs load", game.Rules.Programs.Count > 0, $"{game.Rules.Programs.Count} program(s)");
            Add("start rules set an objective", game.Objective != "", game.Objective);

            yield return Seconds(1f);
            StudioPlayer player = game.Player;
            float y = player.transform.position.y;
            Add("player rests on the ground", player.Grounded && y > 0.5f && y < 2.5f, $"y = {y:F2}");

            Vector3 start = player.transform.position;
            player.ScriptedInput = new Vector2(0f, 1f);
            yield return Seconds(0.75f);
            player.ScriptedInput = Vector2.zero;
            yield return Seconds(0.1f);
            float walked = Vector3.Distance(start, player.transform.position);
            Add("player walks forward", walked > 2f, $"{walked:F2} m");
            player.ScriptedInput = null;

            // Stand next to the first person and press E (the same call the key makes).
            List<string> people = game.Builder.IdsOfType("npc");
            if (people.Count > 0)
            {
                WorldObjectData npc = game.Builder.Objects[people[0]];
                player.Teleport(StudioData.ToUnity(npc.x + 1.6f, npc.z, 1.2f));
                yield return Seconds(0.3f);
                int before = game.Rules.Runs.TryGetValue("interact", out int n) ? n : 0;
                int errors = game.Rules.Errors.Count;
                int shown = game.MessagesShown.Count;
                bool used = game.Focus == npc.id && game.Interact();
                int after = game.Rules.Runs.TryGetValue("interact", out int m) ? m : 0;
                bool handled = !game.Rules.Programs.Exists(p => p.Vm.HasHandler("interact")) || after > before;
                string said = game.MessagesShown.Count > shown ? game.MessagesShown[game.MessagesShown.Count - 1] : "no message";
                Add("talking to someone runs the interact rules", used && handled && game.Rules.Errors.Count == errors, $"{npc.id} (focus {game.Focus ?? "none"}): {said}");
            }

            List<string> items = game.Builder.IdsOfType("collectible");
            if (items.Count > 0)
            {
                WorldObjectData first = game.Builder.Objects[items[0]];
                player.Teleport(StudioData.ToUnity(first.x, first.z, 1.2f));
                yield return Seconds(0.2f);
                Add("touching a collectible picks it up", game.Collected.ContainsKey(items[0]), items[0]);
                foreach (string id in items) game.Collect(id);
                Add("every collectible can be collected", game.Collected.Count == items.Count, $"{game.Collected.Count} of {items.Count}");
            }

            foreach (string zone in game.Builder.IdsOfType("zone"))
            {
                WorldObjectData z = game.Builder.Objects[zone];
                player.Teleport(StudioData.ToUnity(z.x, z.z, 1.2f));
                yield return Seconds(0.15f);
            }
            Add("rules run without errors", game.Rules.Errors.Count == 0, string.Join("; ", game.Rules.Errors));
            Add("no errors logged", game.Errors.Count == 0, string.Join("; ", game.Errors));

            var gates = new Dictionary<string, object>();
            foreach (var pair in game.Builder.Gates) gates[pair.Key] = pair.Value.IsOpen;
            var programs = new List<object>();
            foreach (StudioRules.Program p in game.Rules.Programs) programs.Add(p.Id);
            var report = new Dictionary<string, object>
            {
                { "pass", !failed },
                { "checks", checks },
                {
                    "observations", new Dictionary<string, object>
                    {
                        { "engine", "Unity " + Application.unityVersion },
                        { "objects", game.Builder.Nodes.Count },
                        { "collectibles", items.Count },
                        { "collected", game.Collected.Count },
                        { "zonesEntered", new List<string>(game.ZonesEntered) },
                        { "rules", programs },
                        { "objective", game.Objective },
                        { "won", game.Won },
                        { "messages", game.MessagesShown },
                        { "gatesOpen", gates },
                        { "sounds", game.Sounds.Played },
                    }
                },
            };
            Debug.Log("GSTUDIO_SMOKE " + StudioJson.Write(report));
            Application.Quit(failed ? 1 : 0);
        }
    }
}
