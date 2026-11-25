using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using GameStudio.Rules;
using UnityEngine;

namespace GameStudio
{
    // Loads the rule programs Game Studio compiles into StreamingAssets/gamestudio_data and runs them
    // against the level. Mirrors main.gd and explore_host.gd in the Godot template, and ExploreSimHost
    // in the studio's simulator, so a level plays the same in every engine.
    public class StudioRules : IRuleHost
    {
        public class Program { public string Id; public RulesVM Vm; }

        public readonly List<Program> Programs = new List<Program>();
        public readonly List<string> Errors = new List<string>();
        // How many times each event ran at least one handler (the self-test reads it).
        public readonly Dictionary<string, int> Runs = new Dictionary<string, int>();
        readonly StudioGame game;
        readonly bool telemetry;

        public StudioRules(StudioGame owner, bool printTelemetry)
        {
            game = owner;
            telemetry = printTelemetry;
        }

        static string DataDir => Path.Combine(Application.streamingAssetsPath, "gamestudio_data");

        public void Load()
        {
            string index = Path.Combine(DataDir, "rules_index.json");
            if (!File.Exists(index))
            {
                Problem("No compiled rules found. Save the project in Game Studio to compile them.");
                return;
            }
            var data = StudioJson.Parse(File.ReadAllText(index), out string error) as Dictionary<string, object>;
            if (data == null)
            {
                Problem("rules_index.json is not valid JSON " + error);
                return;
            }
            var nameCheck = new Regex("^[a-z0-9][a-z0-9-]*\\.ir\\.json$");
            if (!(data.TryGetValue("programs", out object list) && list is List<object> files)) files = new List<object>();
            foreach (object entry in files)
            {
                string file = entry as string ?? "";
                if (!nameCheck.IsMatch(file))
                {
                    Problem("Ignored rule file with an unexpected name: " + file);
                    continue;
                }
                string path = Path.Combine(DataDir, "rules", file);
                object parsed = File.Exists(path) ? StudioJson.Parse(File.ReadAllText(path), out error) : null;
                if (parsed == null)
                {
                    Problem("Cannot read " + path);
                    continue;
                }
                var vm = new RulesVM();
                string loadError = vm.Load(parsed);
                if (loadError != "")
                {
                    Problem(file + ": " + loadError);
                    continue;
                }
                Programs.Add(new Program { Id = vm.GraphId != "" ? vm.GraphId : file, Vm = vm });
            }
        }

        void Problem(string message)
        {
            Errors.Add(message);
            Debug.LogWarning("Game rules: " + message);
        }

        public void Emit(Dictionary<string, object> data)
        {
            if (telemetry) Debug.Log("GSTUDIO " + StudioJson.Write(data));
        }

        // Sends a game event to every rule program that handles it.
        public void Fire(string ev, Dictionary<string, object> payload)
        {
            foreach (Program p in Programs)
            {
                if (!p.Vm.HasHandler(ev)) continue;
                RunResult r = p.Vm.Run(ev, payload, this);
                Runs[ev] = (Runs.TryGetValue(ev, out int n) ? n : 0) + 1;
                if (r.Error != null) Problem($"Rule error in {p.Id}: {r.Error}");
                foreach (string line in r.Logs) Debug.Log("[rules] " + line);
                Emit(new Dictionary<string, object>
                {
                    { "type", "rule" }, { "program", p.Id }, { "event", ev }, { "payload", payload }, { "trace", r.Trace }, { "logs", r.Logs },
                    { "error", r.Error }, { "errorNode", r.ErrorNode }, { "halted", r.Halted },
                });
            }
        }

        static string Text(Dictionary<string, object> args, string key) => args.TryGetValue(key, out object v) ? RulesVM.ToText(v) : "";

        public Dictionary<string, object> Call(string fn, Dictionary<string, object> args)
        {
            switch (fn)
            {
                case "explore.message":
                    game.ShowMessage(Text(args, "text"), args.TryGetValue("seconds", out object s) && s is double seconds ? (float)seconds : 4f);
                    return null;
                case "explore.objective":
                    game.Objective = Text(args, "text");
                    return null;
                case "explore.openGate":
                {
                    string id = Text(args, "gateId");
                    if (!game.Builder.Gates.TryGetValue(id, out StudioGate gate)) throw new RuleError($"There is no gate '{id}' in this level");
                    gate.Open();
                    return null;
                }
                case "explore.sound":
                    game.Sounds.Play(Text(args, "sound"));
                    return null;
                case "explore.setVisible":
                {
                    string id = Text(args, "objectId");
                    if (!game.SetObjectVisible(id, args.TryGetValue("visible", out object v) && v is bool b && b)) throw new RuleError($"There is no object '{id}' in this level");
                    return null;
                }
                case "explore.win":
                    game.ShowWin(Text(args, "text"));
                    return null;
            }
            throw new RuleError($"Unknown exploration action '{fn}'");
        }

        public object Query(string fn, Dictionary<string, object> args)
        {
            switch (fn)
            {
                case "explore.collectedCount":
                    return (double)game.CollectedCount(Text(args, "kind"));
                case "explore.totalCount":
                    return (double)game.TotalCount(Text(args, "kind"));
                case "explore.isGateOpen":
                    return game.Builder.Gates.TryGetValue(Text(args, "gateId"), out StudioGate gate) && gate.IsOpen;
            }
            throw new RuleError($"Unknown exploration query '{fn}'");
        }
    }

    // Makes the template's sound cues at startup, so the project needs no audio files (as sound_bank.gd does).
    public class StudioSounds : MonoBehaviour
    {
        public readonly List<string> Played = new List<string>();
        readonly Dictionary<string, AudioClip> clips = new Dictionary<string, AudioClip>();
        AudioSource source;

        void Awake()
        {
            source = gameObject.AddComponent<AudioSource>();
            source.playOnAwake = false;
            clips["chime"] = Tone("chime", new[] { 880f, 1318.5f }, 0.45f, 0.35f);
            clips["gate"] = Tone("gate", new[] { 98f, 146.8f }, 1.6f, 0.5f);
            clips["success"] = Tone("success", new[] { 523.3f, 659.3f, 784f }, 1.2f, 0.35f);
            clips["error"] = Tone("error", new[] { 196f, 207.7f }, 0.5f, 0.35f);
        }

        public bool Play(string cue)
        {
            Played.Add(cue);
            if (!clips.TryGetValue(cue, out AudioClip clip)) return false;
            source.PlayOneShot(clip);
            return true;
        }

        static AudioClip Tone(string name, float[] freqs, float duration, float volume)
        {
            const int rate = 22050;
            int count = (int)(rate * duration);
            var data = new float[count];
            for (int i = 0; i < count; i++)
            {
                float t = (float)i / rate;
                float envelope = Mathf.Min(1f, t * 60f) * Mathf.Pow(1f - (float)i / count, 2f);
                float sample = 0f;
                foreach (float f in freqs) sample += Mathf.Sin(2f * Mathf.PI * f * t);
                data[i] = Mathf.Clamp(sample / freqs.Length * envelope * volume, -1f, 1f);
            }
            AudioClip clip = AudioClip.Create(name, count, 1, rate, false);
            clip.SetData(data, 0);
            return clip;
        }
    }
}
