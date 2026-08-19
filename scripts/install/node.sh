detect_openclaw_checkout() {
    local dir="$1"
    if [[ ! -f "$dir/package.json" ]]; then
        return 1
    fi
    if [[ ! -f "$dir/pnpm-workspace.yaml" ]]; then
        return 1
    fi
    if ! grep -q '"name"[[:space:]]*:[[:space:]]*"openclaw"' "$dir/package.json" 2>/dev/null; then
        return 1
    fi
    echo "$dir"
    return 0
}

# Check for Homebrew on macOS
is_macos_admin_user() {
    if [[ "$OS" != "macos" ]]; then
        return 0
    fi
    if is_root; then
        return 0
    fi
    id -Gn "$(id -un)" 2>/dev/null | grep -qw "admin"
}

print_homebrew_admin_fix() {
    local current_user
    current_user="$(id -un 2>/dev/null || echo "${USER:-current user}")"
    ui_error "Homebrew installation requires a macOS Administrator account"
    echo "Current user (${current_user}) is not in the admin group."
    echo "Fix options:"
    echo "  1) Use an Administrator account and re-run the installer."
    echo "  2) Ask an Administrator to grant admin rights, then sign out/in:"
    echo "     sudo dseditgroup -o edit -a ${current_user} -t user admin"
    echo "Then retry:"
    echo "  curl -fsSL https://openclaw.ai/install.sh | bash"
}

install_homebrew() {
    if [[ "$OS" == "macos" ]]; then
        if ! command -v brew &> /dev/null; then
            if ! is_macos_admin_user; then
                print_homebrew_admin_fix
                exit 1
            fi
            ui_info "Homebrew not found, installing"
            run_quiet_step "Installing Homebrew" run_remote_bash "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

            # Add Homebrew to PATH for this session
            if [[ -f "/opt/homebrew/bin/brew" ]]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [[ -f "/usr/local/bin/brew" ]]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
            ui_success "Homebrew installed"
        else
            ui_success "Homebrew already installed"
        fi
    fi
}

# Check Node.js version
parse_node_version_components() {
    if ! command -v node &> /dev/null; then
        return 1
    fi
    local version major minor
    version="$(node -v 2>/dev/null || true)"
    major="${version#v}"
    major="${major%%.*}"
    minor="${version#v}"
    minor="${minor#*.}"
    minor="${minor%%.*}"

    if [[ ! "$major" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    if [[ ! "$minor" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    echo "${major} ${minor}"
    return 0
}

node_major_version() {
    local version_components major minor
    version_components="$(parse_node_version_components || true)"
    read -r major minor <<< "$version_components"
    if [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]]; then
        echo "$major"
        return 0
    fi
    return 1
}

node_is_at_least_required() {
    local version_components major minor
    version_components="$(parse_node_version_components || true)"
    read -r major minor <<< "$version_components"
    if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    if [[ "$major" -gt "$NODE_MIN_MAJOR" ]]; then
        return 0
    fi
    if [[ "$major" -eq "$NODE_MIN_MAJOR" && "$minor" -ge "$NODE_MIN_MINOR" ]]; then
        return 0
    fi
    return 1
}

print_active_node_paths() {
    if ! command -v node &> /dev/null; then
        return 1
    fi
    local node_path node_version npm_path npm_version
    node_path="$(command -v node 2>/dev/null || true)"
    node_version="$(node -v 2>/dev/null || true)"
    ui_info "Active Node.js: ${node_version:-unknown} (${node_path:-unknown})"

    if command -v npm &> /dev/null; then
        npm_path="$(command -v npm 2>/dev/null || true)"
        npm_version="$(npm -v 2>/dev/null || true)"
        ui_info "Active npm: ${npm_version:-unknown} (${npm_path:-unknown})"
    fi
    return 0
}

ensure_macos_default_node_active() {
    if [[ "$OS" != "macos" ]]; then
        return 0
    fi

    local brew_node_prefix=""
    if command -v brew &> /dev/null; then
        brew_node_prefix="$(brew --prefix "node@${NODE_DEFAULT_MAJOR}" 2>/dev/null || true)"
        if [[ -n "$brew_node_prefix" && -x "${brew_node_prefix}/bin/node" ]]; then
            export PATH="${brew_node_prefix}/bin:$PATH"
            refresh_shell_command_cache
        fi
    fi

    local major=""
    major="$(node_major_version || true)"
    if [[ -n "$major" && "$major" -ge 22 ]]; then
        return 0
    fi

    local active_path active_version
    active_path="$(command -v node 2>/dev/null || echo "not found")"
    active_version="$(node -v 2>/dev/null || echo "missing")"

    ui_error "Node.js v${NODE_DEFAULT_MAJOR} was installed but this shell is using ${active_version} (${active_path})"
    if [[ -n "$brew_node_prefix" ]]; then
        echo "Add this to your shell profile and restart shell:"
        echo "  export PATH=\"${brew_node_prefix}/bin:\$PATH\""
    else
        echo "Ensure Homebrew node@${NODE_DEFAULT_MAJOR} is first on PATH, then rerun installer."
    fi
    return 1
}

ensure_default_node_active_shell() {
    if node_is_at_least_required; then
        return 0
    fi

    local active_path active_version
    active_path="$(command -v node 2>/dev/null || echo "not found")"
    active_version="$(node -v 2>/dev/null || echo "missing")"

    ui_error "Active Node.js must be v${NODE_MIN_VERSION}+ but this shell is using ${active_version} (${active_path})"
    print_active_node_paths || true

    local nvm_detected=0
    if [[ -n "${NVM_DIR:-}" || "$active_path" == *"/.nvm/"* ]]; then
        nvm_detected=1
    fi
    if command -v nvm >/dev/null 2>&1; then
        nvm_detected=1
    fi

    if [[ "$nvm_detected" -eq 1 ]]; then
        echo "nvm appears to be managing Node for this shell."
        echo "Run:"
        echo "  nvm install ${NODE_DEFAULT_MAJOR}"
        echo "  nvm use ${NODE_DEFAULT_MAJOR}"
        echo "  nvm alias default ${NODE_DEFAULT_MAJOR}"
        echo "Then open a new shell and rerun:"
        echo "  curl -fsSL https://openclaw.ai/install.sh | bash"
    else
        echo "Install/select Node.js ${NODE_DEFAULT_MAJOR} (or Node ${NODE_MIN_VERSION}+ minimum) and ensure it is first on PATH, then rerun installer."
    fi

    return 1
}

check_node() {
    if command -v node &> /dev/null; then
        NODE_VERSION="$(node_major_version || true)"
        if node_is_at_least_required; then
            ui_success "Node.js v$(node -v | cut -d'v' -f2) found"
            print_active_node_paths || true
            return 0
        else
            if [[ -n "$NODE_VERSION" ]]; then
                ui_info "Node.js $(node -v) found, upgrading to v${NODE_MIN_VERSION}+"
            else
                ui_info "Node.js found but version could not be parsed; reinstalling v${NODE_MIN_VERSION}+"
            fi
            return 1
        fi
    else
        ui_info "Node.js not found, installing it now"
        return 1
    fi
}

# Install Node.js
install_node() {
    if [[ "$OS" == "macos" ]]; then
        ui_info "Installing Node.js via Homebrew"
        run_quiet_step "Installing node@${NODE_DEFAULT_MAJOR}" brew install "node@${NODE_DEFAULT_MAJOR}"
        brew link "node@${NODE_DEFAULT_MAJOR}" --overwrite --force 2>/dev/null || true
        if ! ensure_macos_default_node_active; then
            exit 1
        fi
        ui_success "Node.js installed"
        print_active_node_paths || true
    elif [[ "$OS" == "linux" ]]; then
        require_sudo

        ui_info "Installing Linux build tools (make/g++/cmake/python3)"
        if install_build_tools_linux; then
            ui_success "Build tools installed"
        else
            ui_warn "Continuing without auto-installing build tools"
        fi

        # Arch-based distros: use pacman with official repos
        if command -v pacman &> /dev/null || is_arch_linux; then
            ui_info "Installing Node.js via pacman (Arch-based distribution detected)"
            if is_root; then
                run_quiet_step "Installing Node.js" pacman -Sy --noconfirm nodejs npm
            else
                run_quiet_step "Installing Node.js" sudo pacman -Sy --noconfirm nodejs npm
            fi
            ui_success "Node.js v${NODE_DEFAULT_MAJOR} installed"
            print_active_node_paths || true
            return 0
        fi

        ui_info "Installing Node.js via NodeSource"
        if command -v apt-get &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            download_file "https://deb.nodesource.com/setup_${NODE_DEFAULT_MAJOR}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" apt-get install -y -qq nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo -E bash "$tmp"
                run_quiet_step "Installing Node.js" sudo apt-get install -y -qq nodejs
            fi
        elif command -v dnf &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            download_file "https://rpm.nodesource.com/setup_${NODE_DEFAULT_MAJOR}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" dnf install -y -q nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp"
                run_quiet_step "Installing Node.js" sudo dnf install -y -q nodejs
            fi
        elif command -v yum &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            download_file "https://rpm.nodesource.com/setup_${NODE_DEFAULT_MAJOR}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" yum install -y -q nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp"
                run_quiet_step "Installing Node.js" sudo yum install -y -q nodejs
            fi
        else
            ui_error "Could not detect package manager"
            echo "Please install Node.js ${NODE_DEFAULT_MAJOR} manually (or Node ${NODE_MIN_VERSION}+ minimum): https://nodejs.org"
            exit 1
        fi

        ui_success "Node.js v${NODE_DEFAULT_MAJOR} installed"
        print_active_node_paths || true
    fi
}

# Check Git
check_git() {
    if command -v git &> /dev/null; then
        ui_success "Git already installed"
        return 0
    fi
    ui_info "Git not found, installing it now"
    return 1
}

is_root() {
    [[ "$(id -u)" -eq 0 ]]
}

# Run a command with sudo only if not already root
maybe_sudo() {
    if is_root; then
        # Skip -E flag when root (env is already preserved)
        if [[ "${1:-}" == "-E" ]]; then
            shift
        fi
        "$@"
    else
        sudo "$@"
    fi
}

require_sudo() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi
    if is_root; then
        return 0
    fi
    if command -v sudo &> /dev/null; then
        if ! sudo -n true >/dev/null 2>&1; then
            ui_info "Administrator privileges required; enter your password"
            sudo -v
        fi
        return 0
    fi
    ui_error "sudo is required for system installs on Linux"
    echo "  Install sudo or re-run as root."
    exit 1
}

install_git() {
    if [[ "$OS" == "macos" ]]; then
        run_quiet_step "Installing Git" brew install git
    elif [[ "$OS" == "linux" ]]; then
        require_sudo
        if command -v apt-get &> /dev/null; then
            if is_root; then
                run_quiet_step "Updating package index" apt-get update -qq
                run_quiet_step "Installing Git" apt-get install -y -qq git
            else
                run_quiet_step "Updating package index" sudo apt-get update -qq
                run_quiet_step "Installing Git" sudo apt-get install -y -qq git
            fi
        elif command -v pacman &> /dev/null || is_arch_linux; then
            if is_root; then
                run_quiet_step "Installing Git" pacman -Sy --noconfirm git
            else
                run_quiet_step "Installing Git" sudo pacman -Sy --noconfirm git
            fi
        elif command -v dnf &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" dnf install -y -q git
            else
                run_quiet_step "Installing Git" sudo dnf install -y -q git
            fi
        elif command -v yum &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" yum install -y -q git
            else
                run_quiet_step "Installing Git" sudo yum install -y -q git
            fi
        else
            ui_error "Could not detect package manager for Git"
            exit 1
        fi
    fi
    ui_success "Git installed"
}

# Fix npm permissions for global installs (Linux)
