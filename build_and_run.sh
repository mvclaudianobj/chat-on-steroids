#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_USER=${APP_USER:-${SUDO_USER:-${USER:-marcos}}}
if [[ "$APP_USER" == "root" ]]; then
  APP_USER=marcos
fi

if [[ $EUID -eq 0 ]]; then
  USER_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)
else
  USER_HOME=${HOME}
fi

if [[ -z "${USER_HOME:-}" || ! -d "$USER_HOME" ]]; then
  printf 'Usuário inválido: %s\n' "$APP_USER" >&2
  exit 1
fi

if [[ $EUID -eq 0 ]] && ! id -u "$APP_USER" >/dev/null 2>&1; then
  printf 'Usuário não encontrado: %s\n' "$APP_USER" >&2
  exit 1
fi

APP_UID=$(id -u "$APP_USER")
if [[ -d "/run/user/$APP_UID" && -w "/run/user/$APP_UID" ]]; then
  RUNTIME_DIR="/run/user/$APP_UID/chat-on-steroids"
else
  RUNTIME_DIR="${USER_HOME}/.cache/chat-on-steroids"
fi

PID_FILE="$RUNTIME_DIR/app.pid"
LOG_FILE="$RUNTIME_DIR/app.log"
APP_DATA_DIR="$USER_HOME/.config/chat-on-steroids"
APP_CACHE_DIR="$USER_HOME/.cache/chat-on-steroids"
TUNNEL_STATE_DIR="$USER_HOME/.local/state/tunnel-client"
RESET_BACKUP_ROOT="$USER_HOME/.local/state/chat-on-steroids/reset-backups"

run_as_user() {
  if [[ $EUID -eq 0 ]]; then
    runuser -u "$APP_USER" -- env \
      HOME="$USER_HOME" \
      USER="$APP_USER" \
      LOGNAME="$APP_USER" \
      XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u "$APP_USER")}" \
      DISPLAY="${DISPLAY:-:0}" \
      XAUTHORITY="${XAUTHORITY:-$USER_HOME/.Xauthority}" \
      DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u "$APP_USER")/bus}" \
      PATH="${PATH}" \
      bash -lc "$*"
  else
    bash -lc "$*"
  fi
}

ensure_runtime() {
  run_as_user "mkdir -p '$RUNTIME_DIR'"
}

write_pid() {
  local pid=$1
  run_as_user "printf '%s\\n' '$pid' > '$PID_FILE'"
}

clear_pid() {
  run_as_user "rm -f '$PID_FILE'"
}

require_tools() {
  local tool
  for tool in bun node; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf 'Ferramenta ausente: %s\n' "$tool" >&2
      exit 1
    fi
  done
}

is_running() {
  [[ -s "$PID_FILE" ]] || return 1
  local pid
  pid=$(<"$PID_FILE")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ -d "/proc/$pid" ]] || return 1
  [[ "$(stat -c '%u' "/proc/$pid" 2>/dev/null || true)" == "$APP_UID" ]] || return 1
  [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null || true)" == "$ROOT_DIR" ]] || return 1
  local cmdline
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  [[ "$cmdline" == *"bun run dev"* || "$cmdline" == *"electron-vite dev"* ]]
}

find_running_pid() {
  local pid cwd cmdline
  for proc in /proc/[0-9]*; do
    pid=${proc##*/}
    [[ -r "$proc/cmdline" ]] || continue
    [[ "$(stat -c '%u' "$proc" 2>/dev/null || true)" == "$APP_UID" ]] || continue
    cwd=$(readlink "$proc/cwd" 2>/dev/null || true)
    [[ "$cwd" == "$ROOT_DIR" ]] || continue
    cmdline=$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)
    [[ "$cmdline" == *"bun run dev"* || "$cmdline" == *"electron-vite dev"* ]] || continue
    printf '%s\n' "$pid"
    return 0
  done
  return 1
}

bootstrap() {
  require_tools
  ensure_runtime
  run_as_user "cd '$ROOT_DIR' && bun install --frozen-lockfile"
  run_as_user "cd '$ROOT_DIR' && bun pm trust --all || true"
  run_as_user "cd '$ROOT_DIR' && bun run tunnel"
}

build_app() {
  bootstrap
  run_as_user "cd '$ROOT_DIR' && bun run typecheck"
  run_as_user "cd '$ROOT_DIR' && bun run build"
}

start_app() {
  ensure_runtime
  if ! is_running; then
    local discovered_pid
    discovered_pid=$(find_running_pid || true)
    if [[ -n "$discovered_pid" ]]; then
      write_pid "$discovered_pid"
    fi
  fi
  if is_running; then
    printf 'Aplicação já está em execução (PID %s)\n' "$(<"$PID_FILE")"
    exit 0
  fi
  clear_pid
  run_as_user "cd '$ROOT_DIR' && : > '$LOG_FILE' && nohup setsid bun run dev >> '$LOG_FILE' 2>&1 < /dev/null & printf '%s' \$! > '$PID_FILE'"
  sleep 2
  local actual_pid
  actual_pid=$(find_running_pid || true)
  if [[ -n "$actual_pid" ]]; then
    write_pid "$actual_pid"
  fi
  if ! is_running; then
    printf 'A aplicação não permaneceu em execução. Consulte %s\n' "$LOG_FILE" >&2
    exit 1
  fi
  printf 'Aplicação iniciada com PID %s\nLog: %s\n' "$(<"$PID_FILE")" "$LOG_FILE"
}

stop_app() {
  if ! is_running; then
    local discovered_pid
    discovered_pid=$(find_running_pid || true)
    if [[ -n "$discovered_pid" ]]; then
      write_pid "$discovered_pid"
    fi
  fi
  if ! is_running; then
    clear_pid
    printf 'Aplicação não está em execução\n'
    return 0
  fi
  local pid
  pid=$(<"$PID_FILE")
  local pgid
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  if [[ "$pgid" =~ ^[0-9]+$ && "$pgid" != "1" ]]; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      clear_pid
      printf 'Aplicação parada\n'
      return 0
    fi
    sleep 0.5
  done
  if [[ "$pgid" =~ ^[0-9]+$ && "$pgid" != "1" ]]; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
  else
    kill -KILL "$pid" 2>/dev/null || true
  fi
  clear_pid
  printf 'Aplicação encerrada após timeout\n'
}

show_logs() {
  ensure_runtime
  if [[ ! -f "$LOG_FILE" ]]; then
    printf 'Log ainda não existe: %s\n' "$LOG_FILE"
    return 0
  fi
  tail -n 100 -f "$LOG_FILE"
}

status_app() {
  if is_running; then
    printf 'running pid=%s log=%s\n' "$(<"$PID_FILE")" "$LOG_FILE"
  else
    printf 'stopped log=%s\n' "$LOG_FILE"
    return 1
  fi
}

reset_backup() {
  local mode=$1
  local timestamp backup_dir archive
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup_dir="$RESET_BACKUP_ROOT/$timestamp-$mode"
  archive="$backup_dir/state.tar.gz"
  run_as_user "mkdir -p '$backup_dir'"
  shift
  local paths=()
  local path
  for path in "$@"; do
    [[ -e "$path" || -L "$path" ]] || continue
    paths+=("$path")
  done
  if ((${#paths[@]})); then
    tar -czf "$archive" --ignore-failed-read --warning=no-file-changed -C / \
      "${paths[@]#/}" >/dev/null
  else
    : > "$archive"
  fi
  printf '%s\n' "$backup_dir"
}

confirm_reset() {
  local mode=$1 phrase=$2 answer
  if [[ ! -t 0 ]]; then
    printf 'Reset %s exige terminal interativo.\n' "$mode" >&2
    exit 1
  fi
  printf 'ATENÇÃO: reset %s é destrutivo, mas terá backup reversível.\n' "$mode" >&2
  printf 'Digite %s para continuar: ' "$phrase" >&2
  IFS= read -r answer
  [[ "$answer" == "$phrase" ]] || {
    printf 'Reset cancelado.\n' >&2
    exit 1
  }
}

require_stopped() {
  if is_running || [[ -n "$(find_running_pid || true)" ]]; then
    printf 'Pare a aplicação antes de executar reset.\n' >&2
    exit 1
  fi
}

move_reset_path() {
  local source=$1 destination_root=$2
  [[ -e "$source" || -L "$source" ]] || return 0
  mkdir -p "$destination_root$(dirname "$source")"
  mv -- "$source" "$destination_root$source"
}

reset_app() {
  local mode=${1:-} dry_run=${2:-0}
  local backup_dir
  case "$mode" in
    config)
      if [[ "$dry_run" == 1 ]]; then
        printf '%s\n' "$APP_DATA_DIR/config.json"
        return 0
      fi
      confirm_reset 'configuração' 'RESET CONFIG'
      backup_dir=$(reset_backup config "$APP_DATA_DIR/config.json")
      mkdir -p "$backup_dir/data"
      move_reset_path "$APP_DATA_DIR/config.json" "$backup_dir/data"
      printf 'Configuração resetada. Backup: %s\n' "$backup_dir"
      ;;
    connections)
      if [[ "$dry_run" == 1 ]]; then
        printf '%s\n' \
          "$APP_DATA_DIR/connector-proof.json" \
          "$APP_DATA_DIR/browser-proof.json" \
          "$APP_DATA_DIR/control-api" \
          "$APP_DATA_DIR/state/connector-identity.json" \
          "$APP_DATA_DIR/state/bridge-commands.json" \
          "$APP_DATA_DIR/state/request-correlations.json"
        return 0
      fi
      confirm_reset 'conexões e túneis' 'RESET CONNECTIONS'
      backup_dir=$(reset_backup connections \
        "$APP_DATA_DIR/connector-proof.json" \
        "$APP_DATA_DIR/browser-proof.json" \
        "$APP_DATA_DIR/control-api" \
        "$APP_DATA_DIR/state/connector-identity.json" \
        "$APP_DATA_DIR/state/bridge-commands.json" \
        "$APP_DATA_DIR/state/request-correlations.json")
      mkdir -p "$backup_dir/data"
      move_reset_path "$APP_DATA_DIR/connector-proof.json" "$backup_dir/data"
      move_reset_path "$APP_DATA_DIR/browser-proof.json" "$backup_dir/data"
      move_reset_path "$APP_DATA_DIR/control-api" "$backup_dir/data"
      move_reset_path "$APP_DATA_DIR/state/connector-identity.json" "$backup_dir/data"
      move_reset_path "$APP_DATA_DIR/state/bridge-commands.json" "$backup_dir/data"
      move_reset_path "$APP_DATA_DIR/state/request-correlations.json" "$backup_dir/data"
      printf 'Conexões e estado de túnel resetados. Perfis globais do tunnel-client foram preservados. Backup: %s\n' "$backup_dir"
      ;;
    total)
      if [[ "$dry_run" == 1 ]]; then
        printf '%s\n' "$APP_DATA_DIR" "$APP_CACHE_DIR" "$TUNNEL_STATE_DIR" \
          "$USER_HOME/.config/chromium" "$USER_HOME/.config/google-chrome" \
          "$USER_HOME/.config/google-chrome-headless"
        return 0
      fi
      confirm_reset 'total, incluindo túnel e navegador' 'RESET TOTAL'
      backup_dir=$(reset_backup total \
        "$APP_DATA_DIR" "$APP_CACHE_DIR" "$TUNNEL_STATE_DIR" \
        "$USER_HOME/.config/chromium" "$USER_HOME/.config/google-chrome" \
        "$USER_HOME/.config/google-chrome-headless")
      mkdir -p "$backup_dir/data"
      move_reset_path "$APP_DATA_DIR" "$backup_dir/data"
      move_reset_path "$APP_CACHE_DIR" "$backup_dir/data"
      move_reset_path "$TUNNEL_STATE_DIR" "$backup_dir/data"
      move_reset_path "$USER_HOME/.config/chromium" "$backup_dir/data"
      move_reset_path "$USER_HOME/.config/google-chrome" "$backup_dir/data"
      move_reset_path "$USER_HOME/.config/google-chrome-headless" "$backup_dir/data"
      run_as_user "mkdir -p '$APP_DATA_DIR' '$APP_CACHE_DIR'"
      printf 'Reset total concluído. Backup: %s\n' "$backup_dir"
      ;;
    *)
      printf 'Modo de reset inválido: %s\n' "$mode" >&2
      exit 2
      ;;
  esac
  require_stopped
}

usage() {
  printf 'Uso: %s {bootstrap|build|start|stop|restart|logs|status|build-start|reset-config|reset-connections|reset-total} [--dry-run]\n' "$(basename "$0")"
}

DRY_RUN=0
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

case "${1:-}" in
  bootstrap) bootstrap ;;
  build) build_app ;;
  start) start_app ;;
  stop) stop_app ;;
  restart) stop_app; start_app ;;
  logs) show_logs ;;
  status) status_app ;;
  build-start) build_app; stop_app; start_app ;;
  reset-config) reset_app config "$DRY_RUN" ;;
  reset-connections) reset_app connections "$DRY_RUN" ;;
  reset-total) reset_app total "$DRY_RUN" ;;
  *) usage; exit 2 ;;
esac
