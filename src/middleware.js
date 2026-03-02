import helmet from 'helmet';

export function applySecurityMiddleware(router) {
  if (typeof router.use !== 'function') {
    return;
  }
  router.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    })
  );
}
