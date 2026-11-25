using System;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GameStudio.EditorTools
{
    // Entry points Game Studio calls with -executeMethod. The main scene is generated here rather
    // than shipped as a file: it holds one object with StudioGame, which builds the level at runtime.
    [InitializeOnLoad]
    public static class StudioBuild
    {
        public const string MainScene = "Assets/GameStudio/Scenes/Main.unity";
        // The level is built at runtime, so no scene object references a shader at build time and
        // Unity would strip the Standard shader (everything renders magenta). A material under
        // Resources/ keeps it in the build.
        public const string LitMaterial = "Assets/GameStudio/Resources/StudioLit.mat";

        static StudioBuild()
        {
            if (!Application.isBatchMode) EditorApplication.delayCall += () => EnsureMainScene();
        }

        public static void EnsureMaterial()
        {
            if (File.Exists(LitMaterial)) return;
            Directory.CreateDirectory(Path.GetDirectoryName(LitMaterial));
            var material = new Material(Shader.Find("Standard")) { name = "StudioLit" };
            material.SetFloat("_Glossiness", 0.15f);
            AssetDatabase.CreateAsset(material, LitMaterial);
            AssetDatabase.SaveAssets();
            Debug.Log("GSTUDIO created " + LitMaterial);
        }

        public static void EnsureMainScene()
        {
            EnsureMaterial();
            if (!File.Exists(MainScene))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(MainScene));
                var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                new GameObject("Game Studio").AddComponent<StudioGame>();
                EditorSceneManager.SaveScene(scene, MainScene);
                Debug.Log("GSTUDIO created " + MainScene);
            }
            var scenes = EditorBuildSettings.scenes;
            if (scenes.Length != 1 || scenes[0].path != MainScene) EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(MainScene, true) };
        }

        // Opens the editor on the main scene (used by Game Studio's "Open in Unity").
        public static void OpenMainScene()
        {
            EnsureMainScene();
            EditorSceneManager.OpenScene(MainScene);
            Debug.Log("Game Studio opened " + MainScene);
        }

        static string Arg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        // -studioOutput <path>.app  [-studioProduct <name>]  [-studioBundleId <id>]
        public static void BuildMac()
        {
            string output = Arg("-studioOutput");
            if (string.IsNullOrEmpty(output) || !output.EndsWith(".app"))
            {
                Debug.LogError("GSTUDIO_BUILD needs -studioOutput <path>.app");
                EditorApplication.Exit(2);
                return;
            }
            EnsureMainScene();
            string product = Arg("-studioProduct");
            if (!string.IsNullOrEmpty(product)) PlayerSettings.productName = product;
            PlayerSettings.companyName = "Game Studio";
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Standalone, Arg("-studioBundleId") ?? "com.gamestudio.unity");
            PlayerSettings.fullScreenMode = FullScreenMode.Windowed;
            PlayerSettings.defaultScreenWidth = 1280;
            PlayerSettings.defaultScreenHeight = 720;
            PlayerSettings.resizableWindow = true;
            // Started from Game Studio the window may open behind the studio; keep the game running anyway.
            PlayerSettings.runInBackground = true;
            var options = new BuildPlayerOptions { scenes = new[] { MainScene }, locationPathName = output, target = BuildTarget.StandaloneOSX, options = BuildOptions.None };
            BuildSummary summary = BuildPipeline.BuildPlayer(options).summary;
            string seconds = summary.totalTime.TotalSeconds.ToString("F1", CultureInfo.InvariantCulture);
            Debug.Log("GSTUDIO_BUILD {\"result\":\"" + summary.result + "\",\"errors\":" + summary.totalErrors + ",\"bytes\":" + summary.totalSize + ",\"seconds\":" + seconds + "}");
            EditorApplication.Exit(summary.result == BuildResult.Succeeded ? 0 : 1);
        }
    }
}
