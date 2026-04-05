#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="copilot-feishu-bridge.service"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="${CONFIG_HOME}/copilot-feishu-bridge"
SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
UNIT_TEMPLATE="${ROOT_DIR}/deploy/systemd/${UNIT_NAME}.in"
UNIT_PATH="${SYSTEMD_DIR}/${UNIT_NAME}"
ENV_TEMPLATE="${ROOT_DIR}/deploy/config/bridge.env.example"
JSON_TEMPLATE="${ROOT_DIR}/deploy/config/config.json"
ENV_PATH="${CONFIG_DIR}/bridge.env"
JSON_PATH="${CONFIG_DIR}/config.json"
USER_HOME="${HOME}"
PATH_VALUE="${PATH}"

YES=0
for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      echo "Usage: $(basename "$0") [-h|--help] [-y|--yes]"
      echo ""
      echo "Options:"
      echo "  -h, --help   show this help and exit"
      echo "  -y, --yes    skip confirmation prompt"
      echo ""
      echo "Cleans, builds, installs the package globally, installs/updates the"
      echo "user systemd service, and restarts it."
      exit 0
      ;;
    -y|--yes) YES=1 ;;
    *)
      echo "Unknown option: ${arg}" >&2
      echo "Run '$(basename "$0") --help' for usage." >&2
      exit 1
      ;;
  esac
done

echo "This will clean, install packages, build, install the package globally, install/update the user service, kill old bridge processes, and restart the service."
echo "repo: ${ROOT_DIR}"
echo "unit: ${UNIT_PATH}"
echo "config: ${ENV_PATH}"
echo "config: ${JSON_PATH}"
echo "note: config.json is the primary bridge config; bridge.env is only for secrets and process env."
if [[ -f "${JSON_PATH}" ]]; then
  echo "note: existing config.json will be preserved."
fi
if [[ "${YES}" -eq 0 ]]; then
  read -r -p "Continue? [y/N] " CONFIRM
  if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
    echo "aborted"
    exit 1
  fi
fi

cd "${ROOT_DIR}"

rm -rf dist
npm install
npm run build

# Remove private flag temporarily for packing, then restore
python3 - package.json <<'PY'
import json, sys
path = sys.argv[1]
d = json.loads(open(path).read())
d.pop("private", None)
open(path, "w").write(json.dumps(d, indent=2) + "\n")
PY

PACK_FILE="$(npm pack --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['filename'])")"

python3 - package.json <<'PY'
import json, sys
path = sys.argv[1]
d = json.loads(open(path).read())
d["private"] = True
open(path, "w").write(json.dumps(d, indent=2) + "\n")
PY

GLOBAL_PREFIX="$(npm prefix -g)"
GLOBAL_ROOT="$(npm root -g)"
GLOBAL_PKG_DIR="${GLOBAL_ROOT}/copilot-feishu-bridge"
GLOBAL_BIN_DIR="${GLOBAL_PREFIX}/bin"

mkdir -p "${GLOBAL_ROOT}" "${GLOBAL_BIN_DIR}"
rm -rf "${GLOBAL_PKG_DIR}"
mkdir -p "${GLOBAL_PKG_DIR}"
tar -xzf "./${PACK_FILE}" -C "${GLOBAL_PKG_DIR}" --strip-components=1
cp -a node_modules "${GLOBAL_PKG_DIR}/"
ln -sf "${GLOBAL_PKG_DIR}/bin/copilot-feishu-bridge.js" "${GLOBAL_BIN_DIR}/copilot-feishu-bridge"
chmod +x "${GLOBAL_PKG_DIR}/bin/copilot-feishu-bridge.js" "${GLOBAL_BIN_DIR}/copilot-feishu-bridge"
rm -f "${PACK_FILE}"

BIN_PATH="$(command -v copilot-feishu-bridge || true)"
if [[ -z "${BIN_PATH}" ]]; then
  echo "copilot-feishu-bridge not found on PATH after install" >&2
  exit 1
fi

mkdir -p "${CONFIG_DIR}" "${SYSTEMD_DIR}"

if [[ ! -f "${ENV_PATH}" ]]; then
  cp "${ENV_TEMPLATE}" "${ENV_PATH}"
  python3 - "${ENV_PATH}" "${USER_HOME}" <<'PY'
from pathlib import Path
import sys
env_path = Path(sys.argv[1])
user_home = sys.argv[2]
text = env_path.read_text()
text = text.replace("$HOME", user_home)
env_path.write_text(text)
PY
fi

if [[ ! -f "${JSON_PATH}" ]]; then
  cp "${JSON_TEMPLATE}" "${JSON_PATH}"
  python3 - "${JSON_PATH}" "${USER_HOME}" "${ROOT_DIR}" <<'PY'
from pathlib import Path
import json, sys
json_path = Path(sys.argv[1])
user_home = sys.argv[2]
root_dir = sys.argv[3]
data = json.loads(json_path.read_text())

def replace_home(value):
    if isinstance(value, str):
        return value.replace("$HOME", user_home)
    if isinstance(value, list):
        return [replace_home(item) for item in value]
    if isinstance(value, dict):
        return {key: replace_home(item) for key, item in value.items()}
    return value

data = replace_home(data)
project = data.setdefault("project", {})
allowed_roots = project.setdefault("allowedRoots", [user_home])
if root_dir not in allowed_roots:
    allowed_roots.append(root_dir)
project["defaultPath"] = root_dir
json_path.write_text(json.dumps(data, indent=2) + "\n")
PY
fi

sed \
  -e "s|@BIN_PATH@|${BIN_PATH}|g" \
  -e "s|@HOME@|${USER_HOME}|g" \
  -e "s|@PATH@|${PATH_VALUE}|g" \
  "${UNIT_TEMPLATE}" > "${UNIT_PATH}"

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}" >/dev/null

systemctl --user stop "${UNIT_NAME}" || true
for _ in $(seq 1 50); do
  if ! systemctl --user is-active --quiet "${UNIT_NAME}"; then
    break
  fi
  sleep 0.2
done
systemctl --user kill --signal=SIGKILL "${UNIT_NAME}" || true
systemctl --user daemon-reload
systemctl --user reset-failed "${UNIT_NAME}" || true
systemctl --user start "${UNIT_NAME}"

echo "verifying service..."
systemctl --user is-active "${UNIT_NAME}" >/dev/null
systemctl --user show "${UNIT_NAME}" -p MainPID -p ExecMainPID -p ActiveEnterTimestamp -p SubState
