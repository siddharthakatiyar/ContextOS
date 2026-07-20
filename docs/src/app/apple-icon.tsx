import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000000",
          fontFamily: "monospace",
          fontSize: 96,
          fontWeight: 700,
          color: "#ffffff",
        }}
      >
        {">_"}
      </div>
    ),
    {
      ...size,
    }
  );
}
