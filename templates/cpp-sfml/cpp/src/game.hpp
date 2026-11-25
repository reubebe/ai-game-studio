#pragma once
// Crystal Catcher rules: deterministic, no rendering, no SFML. See tests/game_tests.cpp.
#include <cstdint>
#include <string>
#include <vector>

namespace game {

struct Config {
    float width = 800.0f;
    float height = 600.0f;
    float playerY = 540.0f;
    float playerSpeed = 420.0f;
    float playerWidth = 96.0f;
    float crystalRadius = 14.0f;
    float fallSpeed = 170.0f;
    float speedUpPerCrystal = 6.0f;
    float spawnInterval = 0.85f;
    int lives = 3;
    int targetScore = 20;
    std::uint32_t seed = 1234;
};

struct Crystal {
    float x;
    float y;
};

struct State {
    float playerX = 0.0f;
    std::vector<Crystal> crystals;
    int score = 0;
    int lives = 0;
    float spawnTimer = 0.0f;
    float time = 0.0f;
    bool won = false;
    bool lost = false;
    std::uint32_t rng = 1;
};

// Parses "key = value" lines. Unknown keys and invalid values are reported in warnings and ignored.
Config parseConfig(const std::string& text, std::vector<std::string>& warnings);
Config loadConfig(const std::string& path, std::vector<std::string>& warnings);

State newGame(const Config& config);

// Advances the game by dt seconds. direction is -1 (left), 0 or 1 (right).
void step(State& state, const Config& config, float dt, int direction);

// xorshift32: the same seed always gives the same crystals.
std::uint32_t nextRandom(std::uint32_t& state);

}  // namespace game
