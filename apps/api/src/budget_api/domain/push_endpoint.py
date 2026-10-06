"""Which subscription endpoints the server agrees to POST to — pure, no I/O.

The subscribe route stores a URL the CLIENT supplied, and the server later POSTs
to it on its own (the daily job, ``/push/test``). Unchecked, that is a request-
forgery primitive aimed at the server's own network: ``http://127.0.0.1:5443``,
the LAN, a cloud metadata address. The guard is deliberately minimal (grooming
decision 1): ``https`` only, and the host must be a dotted ASCII NAME — it refuses
IP literals (inet_aton spellings included), ``localhost``, bare single labels (the
compose service names this container reaches: ``minio``, ``postgres``) and
non-ASCII hosts (fullwidth digits an IDNA/UTS46 encoder maps to an IP). A dotted
name resolves wherever DNS says, internal ones included; redirects are refused by
the sender (``services/push_sender``), so the guard is not bypassed by a 30x.

What it deliberately does NOT do:

* no allowlist of vendor push hosts — it would break legitimate browsers (Samsung
  Internet, UnifiedPush distributors, whatever ships next) for a gain the https +
  name rule already mostly buys;
* no DNS resolution — a pure function cannot, and a resolve-then-connect check is
  racy anyway (the name can re-resolve between the check and the request).

``allow_insecure`` (``Settings.push_allow_insecure_endpoints``) switches ALL of it
off for one purpose only: a local stub push service on a QA stand.
"""

import ipaddress
import re
from urllib.parse import urlsplit

#: inet_aton-style numeric hosts (``127.1``, ``2130706433``, ``0x7f000001``) are
#: accepted by the resolver as IPv4 literals though ``ipaddress`` rejects them.
#: No real top-level domain is numeric, so a numeric LAST label is never a name.
_NUMERIC_LABEL = re.compile(r"^(0x[0-9a-f]*|[0-9]+)$")


def endpoint_allowed(url: str, *, allow_insecure: bool) -> bool:
    """True when the server may POST to ``url`` as a push endpoint."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        # urlsplit refuses e.g. an unbalanced IPv6 bracket.
        return False
    if not host:
        return False
    if allow_insecure:
        return parts.scheme in ("http", "https")
    if parts.scheme != "https":
        return False
    host = host.rstrip(".")
    if not host.isascii():
        return False
    if "." not in host:
        # Bare labels (``localhost`` too): no public push host is one, and they are
        # exactly the compose service names. Dotless IPv6 literals land here as well.
        return False
    if host.endswith(".localhost"):
        return False
    if _NUMERIC_LABEL.match(host.rsplit(".", 1)[-1]):
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return True
    return False
