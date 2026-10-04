// Windows release builds must not pop a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_manager_lib::run()
}