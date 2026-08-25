import socket, struct, random

def connect_test(host, port):
    try:
        ip = socket.gethostbyname(host)
    except Exception as e:
        return "DNS failed: %s" % e
    tid = random.randint(0, 2**31)
    pkt = struct.pack('>QII', 0x41727101980, 0, tid)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(6)
    try:
        s.sendto(pkt, (ip, port))
        data, _ = s.recvfrom(2048)
        action, rtid, cid = struct.unpack('>IIQ', data[:16])
        return "OK   ip=%s action=%d connection_id=%d" % (ip, action, cid)
    except PermissionError:
        return "EPERM - firewall dropped it   ip=%s" % ip
    except socket.timeout:
        return "timeout - no reply   ip=%s" % ip
    except Exception as e:
        return "%s: %s   ip=%s" % (type(e).__name__, e, ip)
    finally:
        s.close()

for h, p in [("tracker.opentrackr.org", 1337),
             ("open.demonii.com", 1337),
             ("tracker.torrent.eu.org", 451)]:
    print("  %s:%d" % (h, p))
    print("     %s" % connect_test(h, p))
