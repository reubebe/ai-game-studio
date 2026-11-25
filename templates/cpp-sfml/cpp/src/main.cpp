// Crystal Catcher: move with the arrow keys or A/D, catch the falling sun crystals.
// --smoke runs the rules headlessly with a simple autopilot and prints one JSON line.
#include <SFML/Graphics.hpp>

#include <algorithm>
#include <cstring>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

#include "game.hpp"

namespace {

int autopilot(const game::State& s, const game::Config& c) {
    const game::Crystal* target = nullptr;
    for (const auto& cr : s.crystals) {
        if (cr.y > c.playerY) continue;
        if (target == nullptr || cr.y > target->y) target = &cr;
    }
    if (target == nullptr) return 0;
    if (target->x < s.playerX - 6.0f) return -1;
    if (target->x > s.playerX + 6.0f) return 1;
    return 0;
}

int runSmoke(const game::Config& c, const std::vector<std::string>& warnings) {
    game::State s = game::newGame(c);
    int frames = 0;
    for (; frames < 60 * 120 && !s.won && !s.lost; ++frames) game::step(s, c, 1.0f / 60.0f, autopilot(s, c));
    const bool pass = s.score > 0 && warnings.empty();
    std::cout << "GSTUDIO_SMOKE {\"pass\":" << (pass ? "true" : "false") << ",\"score\":" << s.score << ",\"lives\":" << s.lives
              << ",\"won\":" << (s.won ? "true" : "false") << ",\"frames\":" << frames << ",\"warnings\":" << warnings.size() << "}" << std::endl;
    return pass ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) {
    std::string configPath = "game.cfg";
    bool smoke = false;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--smoke") == 0) smoke = true;
        else if (std::strcmp(argv[i], "--config") == 0 && i + 1 < argc) configPath = argv[++i];
    }
    std::vector<std::string> warnings;
    const game::Config config = game::loadConfig(configPath, warnings);
    for (const auto& w : warnings) std::cerr << "config: " << w << std::endl;
    if (smoke) return runSmoke(config, warnings);

    sf::RenderWindow window(sf::VideoMode({static_cast<unsigned>(config.width), static_cast<unsigned>(config.height)}), "Crystal Catcher", sf::Style::Titlebar | sf::Style::Close);
    window.setFramerateLimit(60);

    sf::Font font;
    const bool hasFont = font.openFromFile("/System/Library/Fonts/Supplemental/Arial.ttf");
    std::optional<sf::Text> hud;
    if (hasFont) {
        hud.emplace(font, "", 20);
        hud->setPosition({16.0f, 12.0f});
        hud->setFillColor(sf::Color(232, 238, 247));
    }

    game::State state = game::newGame(config);
    sf::Clock clock;
    while (window.isOpen()) {
        while (const std::optional event = window.pollEvent()) {
            if (event->is<sf::Event::Closed>()) window.close();
            else if (const auto* key = event->getIf<sf::Event::KeyPressed>()) {
                if (key->code == sf::Keyboard::Key::Escape) window.close();
                if (key->code == sf::Keyboard::Key::R && (state.won || state.lost)) state = game::newGame(config);
            }
        }
        const float dt = std::min(clock.restart().asSeconds(), 0.05f);
        int direction = 0;
        if (sf::Keyboard::isKeyPressed(sf::Keyboard::Key::Left) || sf::Keyboard::isKeyPressed(sf::Keyboard::Key::A)) direction -= 1;
        if (sf::Keyboard::isKeyPressed(sf::Keyboard::Key::Right) || sf::Keyboard::isKeyPressed(sf::Keyboard::Key::D)) direction += 1;
        game::step(state, config, dt, direction);

        window.clear(sf::Color(11, 21, 36));
        sf::RectangleShape ground({config.width, config.height - config.playerY - 16.0f});
        ground.setPosition({0.0f, config.playerY + 16.0f});
        ground.setFillColor(sf::Color(26, 44, 71));
        window.draw(ground);
        for (const auto& cr : state.crystals) {
            sf::CircleShape gem(config.crystalRadius, 6);
            gem.setOrigin({config.crystalRadius, config.crystalRadius});
            gem.setPosition({cr.x, cr.y});
            gem.setFillColor(sf::Color(242, 184, 75));
            window.draw(gem);
        }
        sf::RectangleShape paddle({config.playerWidth, 16.0f});
        paddle.setOrigin({config.playerWidth / 2.0f, 0.0f});
        paddle.setPosition({state.playerX, config.playerY});
        paddle.setFillColor(sf::Color(56, 201, 180));
        window.draw(paddle);
        for (int i = 0; i < state.lives; ++i) {
            sf::CircleShape life(6.0f);
            life.setPosition({config.width - 24.0f - static_cast<float>(i) * 18.0f, 18.0f});
            life.setFillColor(sf::Color(240, 113, 106));
            window.draw(life);
        }
        if (hud) {
            std::string text = "Crystals " + std::to_string(state.score) + " / " + std::to_string(config.targetScore);
            if (state.won) text += "   You win! Press R to play again";
            if (state.lost) text += "   Out of lives. Press R to try again";
            hud->setString(text);
            window.draw(*hud);
        }
        window.display();
    }
    return 0;
}
