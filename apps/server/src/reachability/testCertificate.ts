// A self-signed certificate for music.example.test, valid until 2126, and its key: for tests that run a real HTTPS
// server (made with openssl req -x509 -newkey ec -days 36500). Test-only: it protects nothing.
export const TEST_HOST = 'music.example.test';

export const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIB3zCCAYSgAwIBAgIUUi7INdoXBSp3MubTFlxmxYBgpf4wCgYIKoZIzj0EAwIw
NDEVMBMGA1UECgwMUGxheWFyciBUZXN0MRswGQYDVQQDDBJtdXNpYy5leGFtcGxl
LnRlc3QwIBcNMjYxMTA3MjAxMzM1WhgPMjEyNjEwMTQyMDEzMzVaMDQxFTATBgNV
BAoMDFBsYXlhcnIgVGVzdDEbMBkGA1UEAwwSbXVzaWMuZXhhbXBsZS50ZXN0MFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+a3cpla4gpz8xUoUp+3oMj2Mentkn/TC
UlnyLRkiF74Rctmav3a1vkOIboycuHu1xZ2gf2NX7LxQ3ileRWN0p6NyMHAwHQYD
VR0OBBYEFEmp97ZdP5UjIBhDbf7lWc7lnw6uMB8GA1UdIwQYMBaAFEmp97ZdP5Uj
IBhDbf7lWc7lnw6uMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0RBBYwFIISbXVzaWMu
ZXhhbXBsZS50ZXN0MAoGCCqGSM49BAMCA0kAMEYCIQCEukqGR0glWEdcGjqhz8/1
Ww/JoJ95fuI0sAyzyqOddwIhALgnrieddPp4QO53CWDNvJtqhL7IhFkrQAeJn6g+
YFfM
-----END CERTIFICATE-----
`;

export const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg5o32S4mtxd/2nGKs
x1hwcBBVuiJmzwfyK4cSbjNFNZKhRANCAAT5rdymVriCnPzFShSn7egyPYx6e2Sf
9MJSWfItGSIXvhFy2Zq/drW+Q4hujJy4e7XFnaB/Y1fsvFDeKV5FY3Sn
-----END PRIVATE KEY-----
`;
