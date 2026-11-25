// Unit tests for the Crystal Catcher rules. Run with ctest, or directly: ./build/game_tests
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "game.hpp"

namespace {
int failures = 0;
void check(bool ok, const std::string& name) {
    std::cout << (ok ? "PASS " : "FAIL ") << name << std::endl;
    if (!ok) ++failures;
}
}  // namespace

int main() {
    using namespace game;
    {
        std::vector<std::string> w;
        Config c = parseConfig("player_speed = 300\nlives=5\n# comment\n\ntarget_score = 7\n", w);
        check(w.empty() && c.playerSpeed == 300.0f && c.lives == 5 && c.targetScore == 7, "parses valid settings");
    }
    {
        std::vector<std::string> w;
        Config c = parseConfig("lives = 2.5\nfall_speed = fast\ncolour = red\nnot a setting\n", w);
        check(w.size() == 4 && c.lives == Config{}.lives && c.fallSpeed == Config{}.fallSpeed, "reports and ignores invalid lines");
    }
    {
        Config c;
        State a = newGame(c), b = newGame(c);
        for (int i = 0; i < 1200; ++i) {
            step(a, c, 1.0f / 60.0f, (i / 40) % 3 - 1);
            step(b, c, 1.0f / 60.0f, (i / 40) % 3 - 1);
        }
        check(a.score == b.score && a.lives == b.lives && a.crystals.size() == b.crystals.size(), "same seed and inputs give the same game");
    }
    {
        Config c;
        State s = newGame(c);
        s.spawnTimer = 100.0f;
        s.crystals.push_back({s.playerX, c.playerY - 20.0f});
        step(s, c, 0.1f, 0);
        check(s.score == 1 && s.crystals.empty(), "catching a crystal scores a point");
    }
    {
        Config c;
        State s = newGame(c);
        s.spawnTimer = 100.0f;
        s.crystals.push_back({20.0f, c.height});
        s.playerX = c.width - 60.0f;
        step(s, c, 0.1f, 0);
        check(s.lives == c.lives - 1 && s.crystals.empty(), "a missed crystal costs a life");
    }
    {
        Config c;
        c.targetScore = 1;
        State s = newGame(c);
        s.spawnTimer = 100.0f;
        s.crystals.push_back({s.playerX, c.playerY - 20.0f});
        step(s, c, 0.1f, 0);
        check(s.won && !s.lost, "reaching the target score wins");
        const int score = s.score;
        step(s, c, 0.1f, 1);
        check(s.score == score, "a finished game no longer changes");
    }
    {
        Config c;
        State s = newGame(c);
        for (int i = 0; i < 600; ++i) step(s, c, 1.0f / 60.0f, -1);
        check(s.playerX >= c.playerWidth / 2.0f - 0.001f, "the player stays on screen");
    }
    std::cout << (failures == 0 ? "ALL PASSED" : "FAILURES: " + std::to_string(failures)) << std::endl;
    return failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
