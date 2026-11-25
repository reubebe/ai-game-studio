cmake_minimum_required(VERSION 3.24)
project(crystal_catcher LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Game rules live in a library with no SFML dependency, so they can be unit-tested headlessly.
add_library(game_core STATIC src/game.cpp)
target_include_directories(game_core PUBLIC src)
if(MSVC)
  target_compile_options(game_core PRIVATE /W4)
else()
  target_compile_options(game_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

find_package(SFML 3 REQUIRED COMPONENTS Graphics Window System)
add_executable(crystal_catcher src/main.cpp)
target_link_libraries(crystal_catcher PRIVATE game_core SFML::Graphics SFML::Window SFML::System)

enable_testing()
add_executable(game_tests tests/game_tests.cpp)
target_link_libraries(game_tests PRIVATE game_core)
add_test(NAME game_tests COMMAND game_tests)
