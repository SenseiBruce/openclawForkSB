install_openclaw_from_git() {
    local repo_dir="$1"
    local repo_url="https://github.com/openclaw/openclaw.git"

    if [[ -d "$repo_dir/.git" ]]; then
        ui_info "Installing OpenClaw from git checkout: ${repo_dir}"
    else
        ui_info "Installing OpenClaw from GitHub (${repo_url})"
    fi

    if ! check_git; then
        install_git
    fi

    ensure_pnpm
    ensure_pnpm_binary_for_scripts

    if [[ ! -d "$repo_dir" ]]; then
        run_quiet_step "Cloning OpenClaw" git clone "$repo_url" "$repo_dir"
    fi

    if [[ "$GIT_UPDATE" == "1" ]]; then
        if [[ -z "$(git -C "$repo_dir" status --porcelain 2>/dev/null || true)" ]]; then
            run_quiet_step "Updating repository" git -C "$repo_dir" pull --rebase || true
        else
            ui_info "Repo has local changes; skipping git pull"
        fi
    fi

    cleanup_legacy_submodules "$repo_dir"

    SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" run_quiet_step "Installing dependencies" run_pnpm -C "$repo_dir" install

    if ! run_quiet_step "Building UI" run_pnpm -C "$repo_dir" ui:build; then
        ui_warn "UI build failed; continuing (CLI may still work)"
    fi
    run_quiet_step "Building OpenClaw" run_pnpm -C "$repo_dir" build

    ensure_user_local_bin_on_path

    cat > "$HOME/.local/bin/openclaw" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${repo_dir}/dist/entry.js" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openclaw"
    ui_success "OpenClaw wrapper installed to \$HOME/.local/bin/openclaw"
    ui_info "This checkout uses pnpm — run pnpm install (or corepack pnpm install) for deps"
}

# Install OpenClaw
resolve_beta_version() {
    local beta=""
    beta="$(npm view openclaw dist-tags.beta 2>/dev/null || true)"
    if [[ -z "$beta" || "$beta" == "undefined" || "$beta" == "null" ]]; then
        return 1
    fi
    echo "$beta"
}

install_openclaw() {
    local package_name="openclaw"
    if [[ "$USE_BETA" == "1" ]]; then
        local beta_version=""
        beta_version="$(resolve_beta_version || true)"
        if [[ -n "$beta_version" ]]; then
            OPENCLAW_VERSION="$beta_version"
            ui_info "Beta tag detected (${beta_version})"
            package_name="openclaw"
        else
            OPENCLAW_VERSION="latest"
            ui_info "No beta tag found; using latest"
        fi
    fi

    if [[ -z "${OPENCLAW_VERSION}" ]]; then
        OPENCLAW_VERSION="latest"
    fi

    local resolved_version=""
    resolved_version="$(npm view "${package_name}@${OPENCLAW_VERSION}" version 2>/dev/null || true)"
    if [[ -n "$resolved_version" ]]; then
        ui_info "Installing OpenClaw v${resolved_version}"
    else
        ui_info "Installing OpenClaw (${OPENCLAW_VERSION})"
    fi
    local install_spec=""
    if [[ "${OPENCLAW_VERSION}" == "latest" ]]; then
        install_spec="${package_name}@latest"
    else
        install_spec="${package_name}@${OPENCLAW_VERSION}"
    fi

    if ! install_openclaw_npm "${install_spec}"; then
        ui_warn "npm install failed; retrying"
        cleanup_npm_openclaw_paths
        install_openclaw_npm "${install_spec}"
    fi

    if [[ "${OPENCLAW_VERSION}" == "latest" && "${package_name}" == "openclaw" ]]; then
        if ! resolve_openclaw_bin &> /dev/null; then
            ui_warn "npm install openclaw@latest failed; retrying openclaw@next"
            cleanup_npm_openclaw_paths
            install_openclaw_npm "openclaw@next"
        fi
    fi

    ensure_openclaw_bin_link || true

    ui_success "OpenClaw installed"
}

# Run doctor for migrations (safe, non-interactive)
run_doctor() {
    ui_info "Running doctor to migrate settings"
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        ui_info "Skipping doctor (openclaw not on PATH yet)"
        warn_openclaw_not_found
        return 0
    fi
    run_quiet_step "Running doctor" "$claw" doctor --non-interactive || true
    ui_success "Doctor complete"
}

maybe_open_dashboard() {
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        return 0
    fi
    if ! "$claw" dashboard --help >/dev/null 2>&1; then
        return 0
    fi
    "$claw" dashboard || true
}

resolve_workspace_dir() {
    local profile="${OPENCLAW_PROFILE:-default}"
    if [[ "${profile}" != "default" ]]; then
        echo "${HOME}/.openclaw/workspace-${profile}"
    else
        echo "${HOME}/.openclaw/workspace"
    fi
}

run_bootstrap_onboarding_if_needed() {
    if [[ "${NO_ONBOARD}" == "1" ]]; then
        return
    fi

    local config_path="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
    if [[ -f "${config_path}" || -f "$HOME/.clawdbot/clawdbot.json" || -f "$HOME/.moltbot/moltbot.json" || -f "$HOME/.moldbot/moldbot.json" ]]; then
        return
    fi

    local workspace
    workspace="$(resolve_workspace_dir)"
    local bootstrap="${workspace}/BOOTSTRAP.md"

    if [[ ! -f "${bootstrap}" ]]; then
        return
    fi

    if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
        ui_info "BOOTSTRAP.md found but no TTY; run openclaw onboard to finish setup"
        return
    fi

    ui_info "BOOTSTRAP.md found; starting onboarding"
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        ui_info "BOOTSTRAP.md found but openclaw not on PATH; skipping onboarding"
        warn_openclaw_not_found
        return
    fi

    "$claw" onboard || {
        ui_error "Onboarding failed; run openclaw onboard to retry"
        return
    }
}

load_install_version_helpers() {
    local source_path="${BASH_SOURCE[0]-}"
    local script_dir=""
    local helper_path=""
    if [[ -z "$source_path" || ! -f "$source_path" ]]; then
        return 0
    fi
    script_dir="$(cd "$(dirname "$source_path")" && pwd 2>/dev/null || true)"
    helper_path="${script_dir}/docker/install-sh-common/version-parse.sh"
    if [[ -n "$script_dir" && -r "$helper_path" ]]; then
        # shellcheck source=docker/install-sh-common/version-parse.sh
        source "$helper_path"
    fi
}

load_install_version_helpers

if ! declare -F extract_openclaw_semver >/dev/null 2>&1; then
# Inline fallback when version-parse.sh could not be sourced (for example, stdin install).
extract_openclaw_semver() {
    local raw="${1:-}"
    local parsed=""
    parsed="$(
        printf '%s\n' "$raw" \
            | tr -d '\r' \
            | grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?(\+[0-9A-Za-z.-]+)?' \
            | head -n 1 \
            || true
    )"
    printf '%s' "${parsed#v}"
}
fi

resolve_openclaw_version() {
    local version=""
    local raw_version_output=""
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]] && command -v openclaw &> /dev/null; then
        claw="$(command -v openclaw)"
    fi
    if [[ -n "$claw" ]]; then
        raw_version_output=$("$claw" --version 2>/dev/null | head -n 1 | tr -d '\r')
        version="$(extract_openclaw_semver "$raw_version_output")"
        if [[ -z "$version" ]]; then
            version="$raw_version_output"
        fi
    fi
    if [[ -z "$version" ]]; then
        local npm_root=""
        npm_root=$(npm root -g 2>/dev/null || true)
        if [[ -n "$npm_root" && -f "$npm_root/openclaw/package.json" ]]; then
            version=$(node -e "console.log(require('${npm_root}/openclaw/package.json').version)" 2>/dev/null || true)
        fi
    fi
    echo "$version"
}

is_gateway_daemon_loaded() {
    local claw="$1"
    if [[ -z "$claw" ]]; then
        return 1
    fi

    local status_json=""
    status_json="$("$claw" daemon status --json 2>/dev/null || true)"
    if [[ -z "$status_json" ]]; then
        return 1
    fi

    printf '%s' "$status_json" | node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").trim();
if (!raw) process.exit(1);
try {
  const data = JSON.parse(raw);
  process.exit(data?.service?.loaded ? 0 : 1);
} catch {
  process.exit(1);
}
' >/dev/null 2>&1
}

refresh_gateway_service_if_loaded() {
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        return 0
    fi

    if ! is_gateway_daemon_loaded "$claw"; then
        return 0
    fi

    ui_info "Refreshing loaded gateway service"
    if run_quiet_step "Refreshing gateway service" "$claw" gateway install --force; then
        ui_success "Gateway service metadata refreshed"
    else
        ui_warn "Gateway service refresh failed; continuing"
        return 0
    fi

    if run_quiet_step "Restarting gateway service" "$claw" gateway restart; then
        ui_success "Gateway service restarted"
    else
        ui_warn "Gateway service restart failed; continuing"
        return 0
    fi

    run_quiet_step "Probing gateway service" "$claw" gateway status --deep || true
}

verify_installation() {
    if [[ "${VERIFY_INSTALL}" != "1" ]]; then
        return 0
    fi

    ui_stage "Verifying installation"
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        ui_error "Install verify failed: openclaw not on PATH yet"
        warn_openclaw_not_found
        return 1
    fi

    run_quiet_step "Checking OpenClaw version" "$claw" --version || return 1

    if is_gateway_daemon_loaded "$claw"; then
        run_quiet_step "Checking gateway service" "$claw" gateway status --deep || {
            ui_error "Install verify failed: gateway service unhealthy"
            ui_info "Run: openclaw gateway status --deep"
            return 1
        }
    else
        ui_info "Gateway service not loaded; skipping gateway deep probe"
    fi

    ui_success "Install verify complete"
}
