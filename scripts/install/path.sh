fix_npm_permissions() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi

    local npm_prefix
    npm_prefix="$(npm config get prefix 2>/dev/null || true)"
    if [[ -z "$npm_prefix" ]]; then
        return 0
    fi

    if [[ -w "$npm_prefix" || -w "$npm_prefix/lib" ]]; then
        return 0
    fi

    ui_info "Configuring npm for user-local installs"
    mkdir -p "$HOME/.npm-global"
    npm config set prefix "$HOME/.npm-global"

    # shellcheck disable=SC2016
    local path_line='export PATH="$HOME/.npm-global/bin:$PATH"'
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [[ -f "$rc" ]] && ! grep -q ".npm-global" "$rc"; then
            echo "$path_line" >> "$rc"
        fi
    done

    export PATH="$HOME/.npm-global/bin:$PATH"
    ui_success "npm configured for user installs"
}

ensure_openclaw_bin_link() {
    local npm_root=""
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -z "$npm_root" || ! -d "$npm_root/openclaw" ]]; then
        return 1
    fi
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir || true)"
    if [[ -z "$npm_bin" ]]; then
        return 1
    fi
    mkdir -p "$npm_bin"
    if [[ ! -x "${npm_bin}/openclaw" ]]; then
        ln -sf "$npm_root/openclaw/dist/entry.js" "${npm_bin}/openclaw"
        ui_info "Created openclaw bin link at ${npm_bin}/openclaw"
    fi
    return 0
}

# Check for existing OpenClaw installation
check_existing_openclaw() {
    if [[ -n "$(type -P openclaw 2>/dev/null || true)" ]]; then
        ui_info "Existing OpenClaw installation detected, upgrading"
        return 0
    fi
    return 1
}

set_pnpm_cmd() {
    PNPM_CMD=("$@")
}

pnpm_cmd_pretty() {
    if [[ ${#PNPM_CMD[@]} -eq 0 ]]; then
        echo ""
        return 1
    fi
    printf '%s' "${PNPM_CMD[*]}"
    return 0
}

pnpm_cmd_is_ready() {
    if [[ ${#PNPM_CMD[@]} -eq 0 ]]; then
        return 1
    fi
    "${PNPM_CMD[@]}" --version >/dev/null 2>&1
}

detect_pnpm_cmd() {
    if command -v pnpm &> /dev/null; then
        set_pnpm_cmd pnpm
        return 0
    fi
    if command -v corepack &> /dev/null; then
        if corepack pnpm --version >/dev/null 2>&1; then
            set_pnpm_cmd corepack pnpm
            return 0
        fi
    fi
    return 1
}

ensure_pnpm() {
    if detect_pnpm_cmd && pnpm_cmd_is_ready; then
        ui_success "pnpm ready ($(pnpm_cmd_pretty))"
        return 0
    fi

    if command -v corepack &> /dev/null; then
        ui_info "Configuring pnpm via Corepack"
        corepack enable >/dev/null 2>&1 || true
        if ! run_quiet_step "Activating pnpm" corepack prepare pnpm@10 --activate; then
            ui_warn "Corepack pnpm activation failed; falling back"
        fi
        refresh_shell_command_cache
        if detect_pnpm_cmd && pnpm_cmd_is_ready; then
            if [[ "${PNPM_CMD[*]}" == "corepack pnpm" ]]; then
                ui_warn "pnpm shim not on PATH; using corepack pnpm fallback"
            fi
            ui_success "pnpm ready ($(pnpm_cmd_pretty))"
            return 0
        fi
    fi

    ui_info "Installing pnpm via npm"
    fix_npm_permissions
    run_quiet_step "Installing pnpm" npm install -g pnpm@10
    refresh_shell_command_cache
    if detect_pnpm_cmd && pnpm_cmd_is_ready; then
        ui_success "pnpm ready ($(pnpm_cmd_pretty))"
        return 0
    fi

    ui_error "pnpm installation failed"
    return 1
}

ensure_pnpm_binary_for_scripts() {
    if command -v pnpm >/dev/null 2>&1; then
        return 0
    fi

    if command -v corepack >/dev/null 2>&1; then
        ui_info "Ensuring pnpm command is available"
        corepack enable >/dev/null 2>&1 || true
        corepack prepare pnpm@10 --activate >/dev/null 2>&1 || true
        refresh_shell_command_cache
        if command -v pnpm >/dev/null 2>&1; then
            ui_success "pnpm command enabled via Corepack"
            return 0
        fi
    fi

    if [[ "${PNPM_CMD[*]}" == "corepack pnpm" ]] && command -v corepack >/dev/null 2>&1; then
        ensure_user_local_bin_on_path
        local user_pnpm="${HOME}/.local/bin/pnpm"
        cat >"${user_pnpm}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec corepack pnpm "$@"
EOF
        chmod +x "${user_pnpm}"
        refresh_shell_command_cache

        if command -v pnpm >/dev/null 2>&1; then
            ui_warn "pnpm shim not on PATH; installed user-local wrapper at ${user_pnpm}"
            return 0
        fi
    fi

    ui_error "pnpm command not available on PATH"
    ui_info "Install pnpm globally (npm install -g pnpm@10) and retry"
    return 1
}

run_pnpm() {
    if ! pnpm_cmd_is_ready; then
        ensure_pnpm
    fi
    "${PNPM_CMD[@]}" "$@"
}

ensure_user_local_bin_on_path() {
    local target="$HOME/.local/bin"
    mkdir -p "$target"

    export PATH="$target:$PATH"

    # shellcheck disable=SC2016
    local path_line='export PATH="$HOME/.local/bin:$PATH"'
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [[ -f "$rc" ]] && ! grep -q ".local/bin" "$rc"; then
            echo "$path_line" >> "$rc"
        fi
    done
}

npm_global_bin_dir() {
    local prefix=""
    prefix="$(npm prefix -g 2>/dev/null || true)"
    if [[ -n "$prefix" ]]; then
        if [[ "$prefix" == /* ]]; then
            echo "${prefix%/}/bin"
            return 0
        fi
    fi

    prefix="$(npm config get prefix 2>/dev/null || true)"
    if [[ -n "$prefix" && "$prefix" != "undefined" && "$prefix" != "null" ]]; then
        if [[ "$prefix" == /* ]]; then
            echo "${prefix%/}/bin"
            return 0
        fi
    fi

    echo ""
    return 1
}

refresh_shell_command_cache() {
    hash -r 2>/dev/null || true
}

path_has_dir() {
    local path="$1"
    local dir="${2%/}"
    if [[ -z "$dir" ]]; then
        return 1
    fi
    case ":${path}:" in
        *":${dir}:"*) return 0 ;;
        *) return 1 ;;
    esac
}

warn_shell_path_missing_dir() {
    local dir="${1%/}"
    local label="$2"
    if [[ -z "$dir" ]]; then
        return 0
    fi
    if path_has_dir "$ORIGINAL_PATH" "$dir"; then
        return 0
    fi

    echo ""
    ui_warn "PATH missing ${label}: ${dir}"
    echo "  This can make openclaw show as \"command not found\" in new terminals."
    echo "  Fix (zsh: ~/.zshrc, bash: ~/.bashrc):"
    echo "    export PATH=\"${dir}:\$PATH\""
}

ensure_npm_global_bin_on_path() {
    local bin_dir=""
    bin_dir="$(npm_global_bin_dir || true)"
    if [[ -n "$bin_dir" ]]; then
        export PATH="${bin_dir}:$PATH"
    fi
}

maybe_nodenv_rehash() {
    if command -v nodenv &> /dev/null; then
        nodenv rehash >/dev/null 2>&1 || true
    fi
}

warn_openclaw_not_found() {
    ui_warn "Installed, but openclaw is not discoverable on PATH in this shell"
    echo "  Try: hash -r (bash) or rehash (zsh), then retry."
    local t=""
    t="$(type -t openclaw 2>/dev/null || true)"
    if [[ "$t" == "alias" || "$t" == "function" ]]; then
        ui_warn "Found a shell ${t} named openclaw; it may shadow the real binary"
    fi
    if command -v nodenv &> /dev/null; then
        echo -e "Using nodenv? Run: ${INFO}nodenv rehash${NC}"
    fi

    local npm_prefix=""
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir 2>/dev/null || true)"
    if [[ -n "$npm_prefix" ]]; then
        echo -e "npm prefix -g: ${INFO}${npm_prefix}${NC}"
    fi
    if [[ -n "$npm_bin" ]]; then
        echo -e "npm bin -g: ${INFO}${npm_bin}${NC}"
        echo -e "If needed: ${INFO}export PATH=\"${npm_bin}:\\$PATH\"${NC}"
    fi
}

resolve_openclaw_bin() {
    refresh_shell_command_cache
    local resolved=""
    resolved="$(type -P openclaw 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    ensure_npm_global_bin_on_path
    refresh_shell_command_cache
    resolved="$(type -P openclaw 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    local npm_bin=""
    npm_bin="$(npm_global_bin_dir || true)"
    if [[ -n "$npm_bin" && -x "${npm_bin}/openclaw" ]]; then
        echo "${npm_bin}/openclaw"
        return 0
    fi

    maybe_nodenv_rehash
    refresh_shell_command_cache
    resolved="$(type -P openclaw 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    if [[ -n "$npm_bin" && -x "${npm_bin}/openclaw" ]]; then
        echo "${npm_bin}/openclaw"
        return 0
    fi

    echo ""
    return 1
}

