export const FLASK_TOPICS = [
  {
    id: "flask-route",
    topic: "How does Flask register a route?",
    prompt: "Show me how the @app.route decorator registers a URL rule.",
    requiredMarkers: ["def route(self, rule: str, **options: t.Any)", "self.add_url_rule("],
    requiredFiles: ["src/flask/app.py"],
    grepPattern: "def route",
    grepGlob: "**/app.py"
  }
];
