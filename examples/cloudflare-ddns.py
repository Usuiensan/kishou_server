#!/usr/bin/env python3
"""Scoped, single-record Cloudflare DDNS update (run by systemd timer).

Required environment variables:
  CF_API_TOKEN CF_ZONE_ID CF_RECORD_ID CF_HOSTNAME

The script keeps a dynamic A record current. It does NOT open ports, bypass
CGNAT, or restart RTSP/VRChat sessions. Never log your token.
"""
import ipaddress
import json
import os
import urllib.request


def req(url, method='GET', payload=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    h = {'Accept': 'application/json', **(headers or {})}
    request = urllib.request.Request(url, method=method, data=data, headers=h)
    with urllib.request.urlopen(request, timeout=12) as f:
        return json.load(f)


def main():
    token = os.environ['CF_API_TOKEN']
    zone = os.environ['CF_ZONE_ID']
    record_id = os.environ['CF_RECORD_ID']
    host = os.environ['CF_HOSTNAME'].strip().rstrip('.').lower()

    # If several egress links exist, validate this IPv4 against your router's WAN address.
    ip = req('https://api.ipify.org?format=json')['ip']
    address = ipaddress.ip_address(ip)
    if address.version != 4 or not address.is_global:
        raise RuntimeError('Outbound address is not a global IPv4')

    url = f'https://api.cloudflare.com/client/v4/zones/{zone}/dns_records/{record_id}'
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    current = req(url, headers=headers)
    if not current.get('success'):
        raise RuntimeError(f'Cloudflare GET failed: {current.get("errors")}')
    result = current['result']
    if result.get('type') != 'A' or result.get('name', '').lower().rstrip('.') != host:
        raise RuntimeError('Record type/hostname mismatch; refusing to update')
    if result.get('content') == ip and result.get('proxied') is False and result.get('ttl') == 60:
        print('Unchanged')
        return

    changed = req(url, 'PATCH', {
        'type': 'A', 'name': host, 'content': ip, 'ttl': 60, 'proxied': False
    }, headers)
    if not changed.get('success'):
        raise RuntimeError(f'Cloudflare PATCH failed: {changed.get("errors")}')
    print('Updated A record successfully')


if __name__ == '__main__':
    main()
