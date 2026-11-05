export type ContextEvent = {
  tools?: Record<
    string,
    { input?: { properties?: { path?: { description?: string } | boolean } } }
  >;
};

type PluginContext = {
  session: {
    hook(name: "context", callback: (event: ContextEvent) => void): Promise<unknown>;
  };
};

export default {
  id: "grep-path-hint",
  async setup(ctx: PluginContext) {
    await ctx.session.hook("context", (event) => {
      const path = event.tools?.grep?.input?.properties?.path;
      if (path && typeof path === "object") {
        path.description =
          'A literal file or directory path (no glob or brace patterns). To search several files, pass their directory here and a pattern in include, e.g. include "{send,swap}.go".';
      }
    });
  },
};
