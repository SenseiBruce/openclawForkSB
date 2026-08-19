cleanup_legacy_submodules() {
    local repo_dir="$1"
    local legacy_dir="$repo_dir/Peekaboo"
    if [[ -d "$legacy_dir" ]]; then
        ui_info "Removing legacy submodule checkout: ${legacy_dir}"
        rm -rf "$legacy_dir"
    fi
}

cleanup_npm_openclaw_paths() {
    local npm_root=""
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -z "$npm_root" || "$npm_root" != *node_modules* ]]; then
        return 1
    fi
    rm -rf "$npm_root"/.openclaw-* "$npm_root"/openclaw 2>/dev/null || true
}

extract_openclaw_conflict_path() {
    local log="$1"
    local path=""
    path="$(sed -n 's/.*File exists: //p' "$log" | head -n1)"
    if [[ -z "$path" ]]; then
        path="$(sed -n 's/.*EEXIST: file already exists, //p' "$log" | head -n1)"
    fi
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi
    return 1
}

cleanup_openclaw_bin_conflict() {
    local bin_path="$1"
    if [[ -z "$bin_path" || ( ! -e "$bin_path" && ! -L "$bin_path" ) ]]; then
        return 1
    fi
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir 2>/dev/null || true)"
    if [[ -n "$npm_bin" && "$bin_path" != "$npm_bin/openclaw" ]]; then
        case "$bin_path" in
            "/opt/homebrew/bin/openclaw"|"/usr/local/bin/openclaw")
                ;;
            *)
                return 1
                ;;
        esac
    fi
    if [[ -L "$bin_path" ]]; then
        local target=""
        target="$(readlink "$bin_path" 2>/dev/null || true)"
        if [[ "$target" == *"/node_modules/openclaw/"* ]]; then
            rm -f "$bin_path"
            ui_info "Removed stale openclaw symlink at ${bin_path}"
            return 0
        fi
        return 1
    fi
    local backup=""
    backup="${bin_path}.bak-$(date +%Y%m%d-%H%M%S)"
    if mv "$bin_path" "$backup"; then
        ui_info "Moved existing openclaw binary to ${backup}"
        return 0
    fi
    return 1
}

npm_log_indicates_missing_build_tools() {
    local log="$1"
    if [[ -z "$log" || ! -f "$log" ]]; then
        return 1
    fi

    grep -Eiq "(not found: make|make: command not found|cmake: command not found|CMAKE_MAKE_PROGRAM is not set|Could not find CMAKE|gyp ERR! find Python|no developer tools were found|is not able to compile a simple test program|Failed to build llama\\.cpp|It seems that \"make\" is not installed in your system|It seems that the used \"cmake\" doesn't work properly)" "$log"
}

# Detect Arch-based distributions (Arch Linux, Manjaro, EndeavourOS, etc.)
is_arch_linux() {
    if [[ -f /etc/os-release ]]; then
        local os_id
        os_id="$(grep -E '^ID=' /etc/os-release 2>/dev/null | cut -d'=' -f2 | tr -d '"' || true)"
        case "$os_id" in
            arch|manjaro|endeavouros|arcolinux|garuda|archarm|cachyos|archcraft)
                return 0
                ;;
        esac
        # Also check ID_LIKE for Arch derivatives
        local os_id_like
        os_id_like="$(grep -E '^ID_LIKE=' /etc/os-release 2>/dev/null | cut -d'=' -f2 | tr -d '"' || true)"
        if [[ "$os_id_like" == *arch* ]]; then
            return 0
        fi
    fi
    # Fallback: check for pacman
    if command -v pacman &> /dev/null; then
        return 0
    fi
    return 1
}

install_build_tools_linux() {
    require_sudo

    if command -v apt-get &> /dev/null; then
        if is_root; then
            run_quiet_step "Updating package index" apt-get update -qq
            run_quiet_step "Installing build tools" apt-get install -y -qq build-essential python3 make g++ cmake
        else
            run_quiet_step "Updating package index" sudo apt-get update -qq
            run_quiet_step "Installing build tools" sudo apt-get install -y -qq build-essential python3 make g++ cmake
        fi
        return 0
    fi

    if command -v pacman &> /dev/null || is_arch_linux; then
        if is_root; then
            run_quiet_step "Installing build tools" pacman -Sy --noconfirm base-devel python make cmake gcc
        else
            run_quiet_step "Installing build tools" sudo pacman -Sy --noconfirm base-devel python make cmake gcc
        fi
        return 0
    fi

    if command -v dnf &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" dnf install -y -q gcc gcc-c++ make cmake python3
        else
            run_quiet_step "Installing build tools" sudo dnf install -y -q gcc gcc-c++ make cmake python3
        fi
        return 0
    fi

    if command -v yum &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" yum install -y -q gcc gcc-c++ make cmake python3
        else
            run_quiet_step "Installing build tools" sudo yum install -y -q gcc gcc-c++ make cmake python3
        fi
        return 0
    fi

    if command -v apk &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" apk add --no-cache build-base python3 cmake
        else
            run_quiet_step "Installing build tools" sudo apk add --no-cache build-base python3 cmake
        fi
        return 0
    fi

    ui_warn "Could not detect package manager for auto-installing build tools"
    return 1
}

install_build_tools_macos() {
    local ok=true

    if ! xcode-select -p >/dev/null 2>&1; then
        ui_info "Installing Xcode Command Line Tools (required for make/clang)"
        xcode-select --install >/dev/null 2>&1 || true
        if ! xcode-select -p >/dev/null 2>&1; then
            ui_warn "Xcode Command Line Tools are not ready yet"
            ui_info "Complete the installer dialog, then re-run this installer"
            ok=false
        fi
    fi

    if ! command -v cmake >/dev/null 2>&1; then
        if command -v brew >/dev/null 2>&1; then
            run_quiet_step "Installing cmake" brew install cmake
        else
            ui_warn "Homebrew not available; cannot auto-install cmake"
            ok=false
        fi
    fi

    if ! command -v make >/dev/null 2>&1; then
        ui_warn "make is still unavailable"
        ok=false
    fi
    if ! command -v cmake >/dev/null 2>&1; then
        ui_warn "cmake is still unavailable"
        ok=false
    fi

    [[ "$ok" == "true" ]]
}

auto_install_build_tools_for_npm_failure() {
    local log="$1"
    if ! npm_log_indicates_missing_build_tools "$log"; then
        return 1
    fi

    ui_warn "Detected missing native build tools; attempting automatic setup"
    if [[ "$OS" == "linux" ]]; then
        install_build_tools_linux || return 1
    elif [[ "$OS" == "macos" ]]; then
        install_build_tools_macos || return 1
    else
        return 1
    fi
    ui_success "Build tools setup complete"
    return 0
}

run_npm_global_install() {
    local spec="$1"
    local log="$2"

    local -a cmd
    cmd=(env "SHARP_IGNORE_GLOBAL_LIBVIPS=$SHARP_IGNORE_GLOBAL_LIBVIPS" npm --loglevel "$NPM_LOGLEVEL")
    if [[ -n "$NPM_SILENT_FLAG" ]]; then
        cmd+=("$NPM_SILENT_FLAG")
    fi
    cmd+=(--no-fund --no-audit install -g "$spec")
    local cmd_display=""
    printf -v cmd_display '%q ' "${cmd[@]}"
    LAST_NPM_INSTALL_CMD="${cmd_display% }"

    if [[ "$VERBOSE" == "1" ]]; then
        "${cmd[@]}" 2>&1 | tee "$log"
        return $?
    fi

    if [[ -n "$GUM" ]] && gum_is_tty; then
        local cmd_quoted=""
        local log_quoted=""
        printf -v cmd_quoted '%q ' "${cmd[@]}"
        printf -v log_quoted '%q' "$log"
        run_with_spinner "Installing OpenClaw package" bash -c "${cmd_quoted}>${log_quoted} 2>&1"
        return $?
    fi

    "${cmd[@]}" >"$log" 2>&1
}

extract_npm_debug_log_path() {
    local log="$1"
    local path=""
    path="$(sed -n -E 's/.*A complete log of this run can be found in:[[:space:]]*//p' "$log" | tail -n1)"
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi

    path="$(grep -Eo '/[^[:space:]]+_logs/[^[:space:]]+debug[^[:space:]]*\.log' "$log" | tail -n1 || true)"
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi

    return 1
}

extract_first_npm_error_line() {
    local log="$1"
    grep -E 'npm (ERR!|error)|ERR!' "$log" | head -n1 || true
}

extract_npm_error_code() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) code[[:space:]]+([^[:space:]]+).*$/\2/p' "$log" | head -n1
}

extract_npm_error_syscall() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) syscall[[:space:]]+(.+)$/\2/p' "$log" | head -n1
}

extract_npm_error_errno() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) errno[[:space:]]+(.+)$/\2/p' "$log" | head -n1
}

print_npm_failure_diagnostics() {
    local spec="$1"
    local log="$2"
    local debug_log=""
    local first_error=""
    local error_code=""
    local error_syscall=""
    local error_errno=""

    ui_warn "npm install failed for ${spec}"
    if [[ -n "${LAST_NPM_INSTALL_CMD}" ]]; then
        echo "  Command: ${LAST_NPM_INSTALL_CMD}"
    fi
    echo "  Installer log: ${log}"

    error_code="$(extract_npm_error_code "$log")"
    if [[ -n "$error_code" ]]; then
        echo "  npm code: ${error_code}"
    fi

    error_syscall="$(extract_npm_error_syscall "$log")"
    if [[ -n "$error_syscall" ]]; then
        echo "  npm syscall: ${error_syscall}"
    fi

    error_errno="$(extract_npm_error_errno "$log")"
    if [[ -n "$error_errno" ]]; then
        echo "  npm errno: ${error_errno}"
    fi

    debug_log="$(extract_npm_debug_log_path "$log" || true)"
    if [[ -n "$debug_log" ]]; then
        echo "  npm debug log: ${debug_log}"
    fi

    first_error="$(extract_first_npm_error_line "$log")"
    if [[ -n "$first_error" ]]; then
        echo "  First npm error: ${first_error}"
    fi
}

