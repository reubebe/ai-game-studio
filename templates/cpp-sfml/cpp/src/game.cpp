#include "game.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>

namespace game {

namespace {

std::string trim(const std::string& s) {
    const auto start = s.find_first_not_of(" \t\r");
    if (start == std::string::npos) return "";
    const auto end = s.find_last_not_of(" \t\r");
    return s.substr(start, end - start + 1);
}

bool parseFloat(const std::string& text, float min, float max, float& out) {
    try {
        std::size_t used = 0;
        const float v = std::stof(text, &used);
        if (used != text.size() || !std::isfinite(v) || v < min || v > max) return false;
        out = v;
        return true;
    } catch (...) {
        return false;
    }
}

}  // namespace

std::uint32_t nextRandom(std::uint32_t& s) {
    if (s == 0) s = 0x9E3779B9u;
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
}

Config parseConfig(const std::string& text, std::vector<std::string>& warnings) {
    Config c;
    std::istringstream lines(text);
    std::string line;
    int number = 0;
    while (std::getline(lines, line)) {
        ++number;
        line = trim(line);
        if (line.empty() || line[0] == '#') continue;
        const auto eq = line.find('=');
        if (eq == std::string::npos) {
            warnings.push_back("line " + std::to_string(number) + ": expected key = value");
            continue;
        }
        const std::string key = trim(line.substr(0, eq));
        const std::string value = trim(line.substr(eq + 1));
        float v = 0.0f;
        bool ok = true;
        if (key == "player_speed") ok = parseFloat(value, 50, 2000, c.playerSpeed);
        else if (key == "player_width") ok = parseFloat(value, 20, 400, c.playerWidth);
        else if (key == "fall_speed") ok = parseFloat(value, 20, 1500, c.fallSpeed);
        else if (key == "speed_up_per_crystal") ok = parseFloat(value, 0, 100, c.speedUpPerCrystal);
        else if (key == "spawn_interval") ok = parseFloat(value, 0.1f, 10, c.spawnInterval);
        else if (key == "lives") { ok = parseFloat(value, 1, 99, v) && v == std::floor(v); if (ok) c.lives = static_cast<int>(v); }
        else if (key == "target_score") { ok = parseFloat(value, 1, 9999, v) && v == std::floor(v); if (ok) c.targetScore = static_cast<int>(v); }
        else if (key == "seed") { ok = parseFloat(value, 0, 4294967295.0f, v) && v == std::floor(v); if (ok) c.seed = static_cast<std::uint32_t>(v); }
        else {
            warnings.push_back("line " + std::to_string(number) + ": unknown setting '" + key + "'");
            continue;
        }
        if (!ok) warnings.push_back("line " + std::to_string(number) + ": invalid value for " + key + "; using the default");
    }
    return c;
}

Config loadConfig(const std::string& path, std::vector<std::string>& warnings) {
    std::ifstream file(path);
    if (!file) {
        warnings.push_back("could not open " + path + "; using defaults");
        return Config{};
    }
    std::stringstream buffer;
    buffer << file.rdbuf();
    return parseConfig(buffer.str(), warnings);
}

State newGame(const Config& c) {
    State s;
    s.playerX = c.width / 2.0f;
    s.lives = c.lives;
    s.rng = c.seed == 0 ? 1u : c.seed;
    s.spawnTimer = 0.0f;
    return s;
}

void step(State& s, const Config& c, float dt, int direction) {
    if (s.won || s.lost) return;
    s.time += dt;
    const float half = c.playerWidth / 2.0f;
    s.playerX = std::clamp(s.playerX + static_cast<float>(std::clamp(direction, -1, 1)) * c.playerSpeed * dt, half, c.width - half);

    s.spawnTimer -= dt;
    if (s.spawnTimer <= 0.0f) {
        const float margin = c.crystalRadius * 2.0f;
        const float x = margin + static_cast<float>(nextRandom(s.rng) % 10000) / 10000.0f * (c.width - 2.0f * margin);
        s.crystals.push_back({x, -c.crystalRadius});
        s.spawnTimer += c.spawnInterval;
    }

    const float speed = c.fallSpeed + c.speedUpPerCrystal * static_cast<float>(s.score);
    std::vector<Crystal> remaining;
    remaining.reserve(s.crystals.size());
    for (Crystal cr : s.crystals) {
        cr.y += speed * dt;
        const bool atPlayer = cr.y + c.crystalRadius >= c.playerY && cr.y - c.crystalRadius <= c.playerY + 16.0f;
        if (atPlayer && std::fabs(cr.x - s.playerX) <= half + c.crystalRadius * 0.5f) {
            s.score += 1;
            continue;
        }
        if (cr.y - c.crystalRadius > c.height) {
            s.lives -= 1;
            continue;
        }
        remaining.push_back(cr);
    }
    s.crystals.swap(remaining);
    if (s.score >= c.targetScore) s.won = true;
    else if (s.lives <= 0) s.lost = true;
}

}  // namespace game
