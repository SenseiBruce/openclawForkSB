#!/bin/bash
set -euo pipefail

# OpenClaw Installer for macOS and Linux
# Usage: curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash


INSTALLER_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$INSTALLER_ROOT/install/common.sh" ]]; then
    echo "OpenClaw installer fragments missing; run from a git checkout of scripts/install.sh" >&2
    exit 1
fi
# shellcheck source=install/common.sh
source "$INSTALLER_ROOT/install/common.sh"
# shellcheck source=install/gum.sh
source "$INSTALLER_ROOT/install/gum.sh"
# shellcheck source=install/ui.sh
source "$INSTALLER_ROOT/install/ui.sh"
# shellcheck source=install/npm.sh
source "$INSTALLER_ROOT/install/npm.sh"
# shellcheck source=install/npm-install.sh
source "$INSTALLER_ROOT/install/npm-install.sh"
# shellcheck source=install/args.sh
source "$INSTALLER_ROOT/install/args.sh"
# shellcheck source=install/node.sh
source "$INSTALLER_ROOT/install/node.sh"
# shellcheck source=install/path.sh
source "$INSTALLER_ROOT/install/path.sh"
# shellcheck source=install/package.sh
source "$INSTALLER_ROOT/install/package.sh"

# Main installation flow
main() {
    if [[ "$HELP" == "1" ]]; then
        print_usage
        return 0
    fi

    bootstrap_gum_temp || true
    print_installer_banner
    print_gum_status
    detect_os_or_die

    local detected_checkout=""
    detected_checkout="$(detect_openclaw_checkout "$PWD" || true)"

    if [[ -z "$INSTALL_METHOD" && -n "$detected_checkout" ]]; then
        if ! is_promptable; then
            ui_info "Found OpenClaw checkout but no TTY; defaulting to npm install"
            INSTALL_METHOD="npm"
        else
            local selected_method=""
            selected_method="$(choose_install_method_interactive "$detected_checkout" || true)"
            case "$selected_method" in
                git|npm)
                    INSTALL_METHOD="$selected_method"
                    ;;
                *)
                    ui_error "no install method selected"
                    echo "Re-run with: --install-method git|npm (or set OPENCLAW_INSTALL_METHOD)."
                    exit 2
                    ;;
            esac
        fi
    fi

    if [[ -z "$INSTALL_METHOD" ]]; then
        INSTALL_METHOD="npm"
    fi

    if [[ "$INSTALL_METHOD" != "npm" && "$INSTALL_METHOD" != "git" ]]; then
        ui_error "invalid --install-method: ${INSTALL_METHOD}"
        echo "Use: --install-method npm|git"
        exit 2
    fi

    show_install_plan "$detected_checkout"

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_success "Dry run complete (no changes made)"
        return 0
    fi

    # Check for existing installation
    local is_upgrade=false
    if check_existing_openclaw; then
        is_upgrade=true
    fi
    local should_open_dashboard=false
    local skip_onboard=false

    ui_stage "Preparing environment"

    # Step 1: Homebrew (macOS only)
    install_homebrew

    # Step 2: Node.js
    if ! check_node; then
        install_node
    fi
    if ! ensure_default_node_active_shell; then
        exit 1
    fi

    ui_stage "Installing OpenClaw"

    local final_git_dir=""
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        # Clean up npm global install if switching to git
        if npm list -g openclaw &>/dev/null; then
            ui_info "Removing npm global install (switching to git)"
            npm uninstall -g openclaw 2>/dev/null || true
            ui_success "npm global install removed"
        fi

        local repo_dir="$GIT_DIR"
        if [[ -n "$detected_checkout" ]]; then
            repo_dir="$detected_checkout"
        fi
        final_git_dir="$repo_dir"
        install_openclaw_from_git "$repo_dir"
    else
        # Clean up git wrapper if switching to npm
        if [[ -x "$HOME/.local/bin/openclaw" ]]; then
            ui_info "Removing git wrapper (switching to npm)"
            rm -f "$HOME/.local/bin/openclaw"
            ui_success "git wrapper removed"
        fi

        # Step 3: Git (required for npm installs that may fetch from git or apply patches)
        if ! check_git; then
            install_git
        fi

        # Step 4: npm permissions (Linux)
        fix_npm_permissions

        # Step 5: OpenClaw
        install_openclaw
    fi

    ui_stage "Finalizing setup"

    OPENCLAW_BIN="$(resolve_openclaw_bin || true)"

    # PATH warning: installs can succeed while the user's login shell still lacks npm's global bin dir.
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir || true)"
    if [[ "$INSTALL_METHOD" == "npm" ]]; then
        warn_shell_path_missing_dir "$npm_bin" "npm global bin dir"
    fi
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        if [[ -x "$HOME/.local/bin/openclaw" ]]; then
            warn_shell_path_missing_dir "$HOME/.local/bin" "user-local bin dir (~/.local/bin)"
        fi
    fi

    refresh_gateway_service_if_loaded

    # Step 6: Run doctor for migrations on upgrades and git installs
    local run_doctor_after=false
    if [[ "$is_upgrade" == "true" || "$INSTALL_METHOD" == "git" ]]; then
        run_doctor_after=true
    fi
    if [[ "$run_doctor_after" == "true" ]]; then
        run_doctor
        should_open_dashboard=true
    fi

    # Step 7: If BOOTSTRAP.md is still present in the workspace, resume onboarding
    run_bootstrap_onboarding_if_needed

    local installed_version
    installed_version=$(resolve_openclaw_version)

    echo ""
    if [[ -n "$installed_version" ]]; then
        ui_celebrate "🦞 OpenClaw installed successfully (${installed_version})!"
    else
        ui_celebrate "🦞 OpenClaw installed successfully!"
    fi
    if [[ "$is_upgrade" == "true" ]]; then
        local update_messages=(
            "Leveled up! New skills unlocked. You're welcome."
            "Fresh code, same lobster. Miss me?"
            "Back and better. Did you even notice I was gone?"
            "Update complete. I learned some new tricks while I was out."
            "Upgraded! Now with 23% more sass."
            "I've evolved. Try to keep up. 🦞"
            "New version, who dis? Oh right, still me but shinier."
            "Patched, polished, and ready to pinch. Let's go."
            "The lobster has molted. Harder shell, sharper claws."
            "Update done! Check the changelog or just trust me, it's good."
            "Reborn from the boiling waters of npm. Stronger now."
            "I went away and came back smarter. You should try it sometime."
            "Update complete. The bugs feared me, so they left."
            "New version installed. Old version sends its regards."
            "Firmware fresh. Brain wrinkles: increased."
            "I've seen things you wouldn't believe. Anyway, I'm updated."
            "Back online. The changelog is long but our friendship is longer."
            "Upgraded! Peter fixed stuff. Blame him if it breaks."
            "Molting complete. Please don't look at my soft shell phase."
            "Version bump! Same chaos energy, fewer crashes (probably)."
        )
        local update_message
        update_message="${update_messages[RANDOM % ${#update_messages[@]}]}"
        echo -e "${MUTED}${update_message}${NC}"
    else
        local completion_messages=(
            "Ahh nice, I like it here. Got any snacks? "
            "Home sweet home. Don't worry, I won't rearrange the furniture."
            "I'm in. Let's cause some responsible chaos."
            "Installation complete. Your productivity is about to get weird."
            "Settled in. Time to automate your life whether you're ready or not."
            "Cozy. I've already read your calendar. We need to talk."
            "Finally unpacked. Now point me at your problems."
            "cracks claws Alright, what are we building?"
            "The lobster has landed. Your terminal will never be the same."
            "All done! I promise to only judge your code a little bit."
        )
        local completion_message
        completion_message="${completion_messages[RANDOM % ${#completion_messages[@]}]}"
        echo -e "${MUTED}${completion_message}${NC}"
    fi
    echo ""

    if [[ "$INSTALL_METHOD" == "git" && -n "$final_git_dir" ]]; then
        ui_section "Source install details"
        ui_kv "Checkout" "$final_git_dir"
        ui_kv "Wrapper" "$HOME/.local/bin/openclaw"
        ui_kv "Update command" "openclaw update --restart"
        ui_kv "Switch to npm" "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method npm"
    elif [[ "$is_upgrade" == "true" ]]; then
        ui_info "Upgrade complete"
        if [[ -r /dev/tty && -w /dev/tty ]]; then
            local claw="${OPENCLAW_BIN:-}"
            if [[ -z "$claw" ]]; then
                claw="$(resolve_openclaw_bin || true)"
            fi
            if [[ -z "$claw" ]]; then
                ui_info "Skipping doctor (openclaw not on PATH yet)"
                warn_openclaw_not_found
                return 0
            fi
            local -a doctor_args=()
            if [[ "$NO_ONBOARD" == "1" ]]; then
                if "$claw" doctor --help 2>/dev/null | grep -q -- "--non-interactive"; then
                    doctor_args+=("--non-interactive")
                fi
            fi
            ui_info "Running openclaw doctor"
            local doctor_ok=0
            if (( ${#doctor_args[@]} )); then
                OPENCLAW_UPDATE_IN_PROGRESS=1 "$claw" doctor "${doctor_args[@]}" </dev/tty && doctor_ok=1
            else
                OPENCLAW_UPDATE_IN_PROGRESS=1 "$claw" doctor </dev/tty && doctor_ok=1
            fi
            if (( doctor_ok )); then
                ui_info "Updating plugins"
                OPENCLAW_UPDATE_IN_PROGRESS=1 "$claw" plugins update --all || true
            else
                ui_warn "Doctor failed; skipping plugin updates"
            fi
        else
            ui_info "No TTY; run openclaw doctor and openclaw plugins update --all manually"
        fi
    else
        if [[ "$NO_ONBOARD" == "1" || "$skip_onboard" == "true" ]]; then
            ui_info "Skipping onboard (requested); run openclaw onboard later"
        else
            local config_path="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
            if [[ -f "${config_path}" || -f "$HOME/.clawdbot/clawdbot.json" || -f "$HOME/.moltbot/moltbot.json" || -f "$HOME/.moldbot/moldbot.json" ]]; then
                ui_info "Config already present; running doctor"
                run_doctor
                should_open_dashboard=true
                ui_info "Config already present; skipping onboarding"
                skip_onboard=true
            fi
            ui_info "Starting setup"
            echo ""
            if [[ -r /dev/tty && -w /dev/tty ]]; then
                local claw="${OPENCLAW_BIN:-}"
                if [[ -z "$claw" ]]; then
                    claw="$(resolve_openclaw_bin || true)"
                fi
                if [[ -z "$claw" ]]; then
                    ui_info "Skipping onboarding (openclaw not on PATH yet)"
                    warn_openclaw_not_found
                    return 0
                fi
                exec </dev/tty
                exec "$claw" onboard
            fi
            ui_info "No TTY; run openclaw onboard to finish setup"
            return 0
        fi
    fi

    if command -v openclaw &> /dev/null; then
        local claw="${OPENCLAW_BIN:-}"
        if [[ -z "$claw" ]]; then
            claw="$(resolve_openclaw_bin || true)"
        fi
        if [[ -n "$claw" ]] && is_gateway_daemon_loaded "$claw"; then
            if [[ "$DRY_RUN" == "1" ]]; then
                ui_info "Gateway daemon detected; would restart (openclaw daemon restart)"
            else
                ui_info "Gateway daemon detected; restarting"
                if OPENCLAW_UPDATE_IN_PROGRESS=1 "$claw" daemon restart >/dev/null 2>&1; then
                    ui_success "Gateway restarted"
                else
                    ui_warn "Gateway restart failed; try: openclaw daemon restart"
                fi
            fi
        fi
    fi

    if ! verify_installation; then
        exit 1
    fi

    if [[ "$should_open_dashboard" == "true" ]]; then
        maybe_open_dashboard
    fi

    show_footer_links
}

if [[ "${OPENCLAW_INSTALL_SH_NO_RUN:-0}" != "1" ]]; then
    parse_args "$@"
    configure_verbose
    main
fi
