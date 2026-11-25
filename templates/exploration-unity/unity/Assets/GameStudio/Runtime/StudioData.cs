using System;
using System.IO;
using UnityEngine;

namespace GameStudio
{
    // The level layout edited in Game Studio (data/world.json). The studio copies it to
    // StreamingAssets/gamestudio_data/world.json when the project is saved.
    [Serializable] public class SpawnPoint { public float x; public float z; }

    [Serializable]
    public class PlayerData
    {
        public SpawnPoint spawn = new SpawnPoint();
        public float speed = 6f;
        public float sprintMultiplier = 1.7f;
        public float jumpVelocity = 5.5f;
        public float cameraDistance = 6f;
    }

    [Serializable] public class SizeData { public float width = 60f; public float depth = 60f; }

    [Serializable]
    public class EnvironmentData
    {
        public string skyTop = "#2f63a8";
        public string skyHorizon = "#b8d4ec";
        public string ground = "#5a7d3c";
        public float sunElevation = 48f;
        public float sunHeading = 35f;
        public float fogDensity;
        public string sunColor = "#ffffff";
    }

    // One class for every object type; fields a type does not use stay at their defaults.
    [Serializable]
    public class WorldObjectData
    {
        public string id;
        public string type;
        public float x;
        public float z;
        public float rotation;
        public float scale = 1f;
        public string variant;
        public string kind;
        public string label;
        public string name;
        public string color;
        public float width = 5f;
        public float radius = 3f;
        public bool visible = true;
        public string text;
    }

    [Serializable]
    public class WorldData
    {
        public string kind;
        public string name;
        public SizeData size = new SizeData();
        public EnvironmentData environment = new EnvironmentData();
        public PlayerData player = new PlayerData();
        public WorldObjectData[] objects = new WorldObjectData[0];
    }

    public static class StudioData
    {
        public static string WorldPath => Path.Combine(Application.streamingAssetsPath, "gamestudio_data", "world.json");

        public static WorldData LoadWorld(out string error)
        {
            error = "";
            string path = WorldPath;
            if (!File.Exists(path))
            {
                error = "Missing " + path;
                return null;
            }
            try
            {
                WorldData world = JsonUtility.FromJson<WorldData>(File.ReadAllText(path));
                if (world == null || world.kind != "explore-world" || world.objects == null)
                {
                    error = "world.json is not an exploration world";
                    return null;
                }
                return world;
            }
            catch (Exception e)
            {
                error = "world.json could not be read: " + e.Message;
                return null;
            }
        }

        // Game Studio and Godot use a right-handed frame with -z as north; Unity is left-handed
        // with +z forward. Mirroring z keeps the layout the same way round as the studio's map.
        public static Vector3 ToUnity(float x, float z, float y = 0f) => new Vector3(x, y, -z);

        public static Quaternion Yaw(float rotation) => Quaternion.Euler(0f, rotation, 0f);

        public static Color ParseColor(string hex, Color fallback) => !string.IsNullOrEmpty(hex) && ColorUtility.TryParseHtmlString(hex, out Color c) ? c : fallback;

        static Material lit;

        // Gives a primitive the studio's lit material (Resources/StudioLit, created by StudioBuild)
        // in the requested colour. Falls back to Unity's default material when it is missing.
        public static void Paint(Renderer renderer, Color color)
        {
            if (lit == null) lit = Resources.Load<Material>("StudioLit");
            if (lit != null) renderer.sharedMaterial = lit;
            renderer.material.color = color;
        }
    }
}
