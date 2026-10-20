type Handler = (req: { params: Record<string, string>; body?: unknown; userId?: string }) => unknown;

const routes: { method: string; path: string; handler: Handler }[] = [];

/** A minimal router: modules register their endpoints here. */
export const router = {
  get: (path: string, handler: Handler) => void routes.push({ method: "GET", path, handler }),
  post: (path: string, handler: Handler) => void routes.push({ method: "POST", path, handler }),
  all: () => routes,
};
