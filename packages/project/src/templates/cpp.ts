import { baseManifest, commonFiles, finalize, type GenerateOptions, type GeneratedProject } from "./common";

const CPP_FILES = import.meta.glob("../../../../templates/cpp-sfml/cpp/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export function generateCpp(o: GenerateOptions): GeneratedProject {
  const manifest = baseManifest(o, {
    template: { id: "cpp-sfml-arcade", version: "1.0.0" },
    genre: ["arcade", "2d", "c++"],
    engine: { id: "cpp-sfml", version: "3", projectDir: "cpp", target: "crystal_catcher" },
    modules: ["engine.cpp-sfml"],
    rules: [],
    data: [],
    portableFeatures: ["settings-file"],
  });
  const readme = `# ${manifest.title}

A small C++17 arcade game built with SFML 3 and CMake: catch the falling sun crystals.

- \`cpp/src/game.cpp\`: the rules, with no rendering code, covered by \`cpp/tests/game_tests.cpp\`.
- \`cpp/src/main.cpp\`: the SFML window, input and drawing.
- \`cpp/game.cfg\`: speeds, lives and the target score. Game Studio's settings form edits this file.

Build, test and run from Game Studio, or by hand:

\`\`\`sh
cmake -S cpp -B cpp/build -DCMAKE_PREFIX_PATH=/opt/homebrew
cmake --build cpp/build
ctest --test-dir cpp/build
(cd cpp && ./build/crystal_catcher)
\`\`\`
`;
  const files = Object.entries(CPP_FILES).flatMap(([key, content]) => {
    const rel = key.split("/templates/cpp-sfml/cpp/")[1];
    return rel ? [{ path: `cpp/${rel}`, content }] : [];
  });
  return finalize(manifest, [...commonFiles(manifest, readme, ["cpp/build/"]), ...files]);
}
