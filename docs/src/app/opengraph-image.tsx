import { ImageResponse } from "next/og";
import { SITE_NAME } from "@/lib/seo";

export const dynamic = "force-static";

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          background: "#000000",
          padding: "80px",
          fontFamily: "monospace",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "20px",
            fontSize: 64,
            fontWeight: 700,
            color: "#ffffff",
          }}
        >
          <span style={{ color: "#ffffff" }}>{">_"}</span>
          <span>{SITE_NAME}</span>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: "32px",
            fontSize: 32,
            color: "#a3a3a3",
            maxWidth: "900px",
          }}
        >
          The Intelligent Retrieval Engine for AI Agents
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
