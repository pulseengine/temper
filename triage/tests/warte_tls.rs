//! warte_ca_file is the only trust root: a server whose certificate the
//! configured CA signed completes the TLS handshake, and one signed by
//! another CA does not. Two CAs and a leaf for 127.0.0.1 are generated per
//! run; `openssl s_server` serves them on a local port.

use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use temper_triage::net::RealWarte;
use temper_triage::Warte;

fn openssl(args: &[&str], dir: &Path) {
    let out = Command::new("openssl")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("openssl runs");
    assert!(
        out.status.success(),
        "openssl {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn ca(dir: &Path, name: &str) {
    openssl(
        &[
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            &format!("/CN={name}"),
            "-keyout",
            &format!("{name}.key"),
            "-out",
            &format!("{name}.pem"),
        ],
        dir,
    );
}

/// A leaf for 127.0.0.1 signed by `ca`.
fn leaf(dir: &Path, ca: &str, name: &str) {
    std::fs::write(
        dir.join("ext.cnf"),
        "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n",
    )
    .unwrap();
    openssl(
        &[
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=127.0.0.1",
            "-keyout",
            &format!("{name}.key"),
            "-out",
            &format!("{name}.csr"),
        ],
        dir,
    );
    openssl(
        &[
            "x509",
            "-req",
            "-in",
            &format!("{name}.csr"),
            "-CA",
            &format!("{ca}.pem"),
            "-CAkey",
            &format!("{ca}.key"),
            "-CAcreateserial",
            "-days",
            "1",
            "-extfile",
            "ext.cnf",
            "-out",
            &format!("{name}.pem"),
        ],
        dir,
    );
}

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn serve(dir: &Path, name: &str) -> (Server, u16) {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let child = Command::new("openssl")
        .args(["s_server", "-quiet", "-www", "-accept"])
        .arg(format!("127.0.0.1:{port}"))
        .args([
            "-cert",
            &format!("{name}.pem"),
            "-key",
            &format!("{name}.key"),
        ])
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("openssl s_server starts");
    let server = Server(child);
    let start = Instant::now();
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "s_server did not listen"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    (server, port)
}

#[test]
fn only_the_configured_ca_is_trusted() {
    let dir = std::env::temp_dir().join(format!("temper-triage-tls-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    ca(&dir, "trusted");
    ca(&dir, "other");
    leaf(&dir, "trusted", "good");
    leaf(&dir, "other", "bad");
    let trusted = dir.join("trusted.pem");
    let trusted = trusted.to_str().unwrap();

    // The handshake succeeds; s_server's -www page is HTML, so the reply
    // fails as JSON, after TLS.
    let (_s, port) = serve(&dir, "good");
    let mut w = RealWarte::new(&format!("https://127.0.0.1:{port}"), "t", Some(trusted)).unwrap();
    let err = w.offer().unwrap_err();
    assert!(!err.contains("tls"), "trusted CA was refused: {err}");

    // Negative control: the same client refuses a certificate from another CA.
    let (_s, port) = serve(&dir, "bad");
    let mut w = RealWarte::new(&format!("https://127.0.0.1:{port}"), "t", Some(trusted)).unwrap();
    let err = w.offer().unwrap_err();
    assert!(err.contains("tls"), "untrusted CA was not refused: {err}");

    std::fs::remove_dir_all(&dir).ok();
}
