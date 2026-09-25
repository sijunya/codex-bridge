#!/usr/bin/env python3
import subprocess
import json
import base64
import sys

def main():
    try:
        raw = subprocess.check_output(
            ['security', 'find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
            stderr=subprocess.DEVNULL
        ).decode('utf-8').strip()
    except Exception as e:
        print(f"[sync-token] Failed to read macOS Keychain: {e}", file=sys.stderr)
        sys.exit(1)

    if raw.startswith('go-keyring-base64:'):
        raw = base64.b64decode(raw[len('go-keyring-base64:'):]).decode('utf-8')

    try:
        data = json.loads(raw)
    except Exception as e:
        print(f"[sync-token] Failed to parse JSON: {e}", file=sys.stderr)
        sys.exit(1)

    id_token = data.get('id_token', '')
    if not id_token:
        print("[sync-token] Missing id_token in token payload", file=sys.stderr)
        sys.exit(1)

    try:
        parts = id_token.split('.')
        payload_b64 = parts[1] + '=' * (-len(parts[1]) % 4)
        payload = json.loads(base64.b64decode(payload_b64).decode('utf-8'))
        email = payload.get('email', '')
    except Exception as e:
        print(f"[sync-token] Failed to decode id_token JWT: {e}", file=sys.stderr)
        sys.exit(1)

    if 'sijunyaya' not in email:
        print(f"[sync-token] Aborting: token is not sijunyaya account ({email})", file=sys.stderr)
        sys.exit(1)

    expiry = data.get('token', {}).get('expiry', 'unknown')
    print(f"[sync-token] Valid token found for {email}, expiry: {expiry}")

    # Check SSH connectivity to 148
    ret = subprocess.run(
        ['ssh', '-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', 'longwei_pve_debian', 'true'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    if ret.returncode != 0:
        print("[sync-token] Host longwei_pve_debian (148) is not reachable right now, skipping sync.")
        sys.exit(0)

    # Sync token to 148
    token_json = json.dumps(data)
    remote_cmd = (
        "cat << 'EOF' > /root/.gemini/antigravity-cli/sijunyaya_golden_token.json && "
        "chmod 600 /root/.gemini/antigravity-cli/sijunyaya_golden_token.json && "
        "cp /root/.gemini/antigravity-cli/sijunyaya_golden_token.json /root/.gemini/antigravity-cli/antigravity-oauth-token && "
        "chmod 600 /root/.gemini/antigravity-cli/antigravity-oauth-token\n"
        f"{token_json}\n"
        "EOF\n"
    )

    proc = subprocess.run(
        ['ssh', 'longwei_pve_debian', remote_cmd],
        capture_output=True,
        text=True
    )
    if proc.returncode == 0:
        print(f"[sync-token] Successfully synced golden token to 148 (expiry: {expiry})")
    else:
        print(f"[sync-token] Error syncing token to 148: {proc.stderr}", file=sys.stderr)
        sys.exit(proc.returncode)

if __name__ == '__main__':
    main()
