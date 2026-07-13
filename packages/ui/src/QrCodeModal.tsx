import React, { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Local QR generation — never sends URL to third parties (F-011).
 */
export function QrCodeModal({
  url,
  open,
  onClose,
}: {
  url: string;
  open: boolean;
  onClose: () => void;
}) {
  const [src, setSrc] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open || !url) {
      setSrc("");
      setErr("");
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(url, {
      width: 200,
      margin: 2,
      errorCorrectionLevel: "M",
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setSrc(dataUrl);
          setErr("");
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setSrc("");
          setErr(e instanceof Error ? e.message : "QR generation failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--panel, #fff)",
          color: "var(--text, #111)",
          padding: 24,
          borderRadius: 12,
          minWidth: 240,
          textAlign: "center",
          boxShadow: "0 8px 30px rgba(0,0,0,.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 12px" }}>QR Code</h3>
        {src ? <img src={src} alt="QR" width={200} height={200} /> : null}
        {err ? <p style={{ color: "crimson", fontSize: 12 }}>{err}</p> : null}
        <p style={{ fontSize: 12, wordBreak: "break-all", opacity: 0.7 }}>{url}</p>
        <button type="button" onClick={onClose} style={{ marginTop: 8 }}>
          Close
        </button>
      </div>
    </div>
  );
}
