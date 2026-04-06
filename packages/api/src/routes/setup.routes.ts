import { Router } from 'express';
import * as setupService from '../services/setup.service.js';

export const setupRouter = Router();

// Security guard: block all setup endpoints once setup is complete
setupRouter.use(async (req, res, next) => {
  if (req.path === '/status') return next(); // status is always accessible
  const status = await setupService.getSetupStatus();
  if (status.setupComplete) {
    res.status(403).json({ error: { message: 'Setup is already complete. These endpoints are disabled.' } });
    return;
  }
  next();
});

setupRouter.get('/status', async (req, res) => {
  const status = await setupService.getSetupStatus();
  res.json(status);
});

setupRouter.post('/generate-secrets', async (req, res) => {
  const secrets = setupService.generateSecrets();
  res.json(secrets);
});

setupRouter.post('/test-database', async (req, res) => {
  const result = await setupService.testDatabaseConnection(req.body);
  res.json(result);
});

setupRouter.post('/check-port', async (req, res) => {
  const { port } = req.body;
  if (!port || port < 1 || port > 65535) {
    res.status(400).json({ error: { message: 'Invalid port number' } });
    return;
  }
  const result = await setupService.checkPortAvailability(Number(port));
  res.json(result);
});

setupRouter.post('/test-smtp', async (req, res) => {
  const result = await setupService.testSmtpConnection(req.body, req.body.testEmail);
  res.json(result);
});

setupRouter.post('/initialize', async (req, res) => {
  try {
    const config = req.body as setupService.SetupConfig;

    // Step 1: Test database connection
    const dbTest = await setupService.testDatabaseConnection(config.db);
    if (!dbTest.success) {
      res.status(400).json({ error: { message: `Database connection failed: ${dbTest.error}` } });
      return;
    }

    // Step 2: Write .env file
    const envPath = setupService.writeEnvFile(config);

    // Step 3: Create admin user and company
    const admin = await setupService.createAdminUser({
      email: config.admin.email,
      password: config.admin.password,
      displayName: config.admin.displayName,
      companyName: config.company.name,
      industry: config.company.industry,
      entityType: config.company.entityType,
      businessType: config.company.businessType,
    });

    res.status(201).json({
      success: true,
      message: 'Setup complete! You can now log in.',
      envPath,
      tenantId: admin.tenantId,
      userId: admin.userId,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err instanceof Error ? err.message : 'Setup failed' } });
  }
});
