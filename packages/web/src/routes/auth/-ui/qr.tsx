import { encode } from 'uqr';

/** The otpauth:// URI as an SVG QR code, drawn the same on the server and the client. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { border: 2 });
  const path = data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join('');
  return (
    <svg className="qr" role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
