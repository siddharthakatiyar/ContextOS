export const ZOD_TOPICS = [
  {
    id: "zod-parse",
    topic: "How does Zod implement the parsing logic for objects?",
    prompt: "Show me the core parsing logic for ZodObject.",
    requiredMarkers: ["_parse(input: ParseInput)", "ZodObject"],
    requiredFiles: ["src/types.ts"],
    grepPattern: "ZodObject",
    grepGlob: "**/types.ts"
  }
];
