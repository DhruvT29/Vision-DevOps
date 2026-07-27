import type { DeployStep, DeployUploadConfig } from '@vision/shared';

/**
 * Seed config modeled 1:1 on the annpriya deploy-staging.ps1 remote pipeline.
 * The engine stays generic; this template is what the "BookMyFresh deploy
 * template" button drops into the target editor, ready to tweak.
 *
 * Placeholders the user fills in: __WORKING_DIR__ is the target's working dir
 * (used here only for readability — steps already `cd` into it), __PM2_APP__
 * and __BACKEND_PORT__ are project-specific.
 */

export interface DeployTemplate {
  workingDir: string;
  preflight: string[];
  upload: DeployUploadConfig;
  steps: DeployStep[];
  healthUrl?: string;
}

export const DEFAULT_EXCLUDE_DIRS = ['node_modules', 'dist', 'build', '.git', '.next'];
export const DEFAULT_EXCLUDE_FILES = [
  '.env',
  '.env.production',
  '.env.development',
  '.env.local',
];

/** Full BookMyFresh/annpriya staging pipeline as editable steps. */
export function bookmyfreshTemplate(localDir: string): DeployTemplate {
  const workingDir = '/var/www/annpriya/annpriya_deploy';
  const remoteZip = '~/vision-deploy.zip';
  return {
    workingDir,
    preflight: [
      // project dir + both env files must exist before we touch anything
      `test -d ${workingDir}/backend && test -f ${workingDir}/backend/.env && test -f ${workingDir}/front_end/.env`,
      // identity guard: confirm this is the staging box, not prod
      `grep -qi staging ${workingDir}/backend/.env`,
    ],
    upload: {
      localDir,
      // staging also excludes plaintext-secret + local-tooling dirs
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS, 'staging-credentials', 'scripts', 'docs'],
      excludeFiles: DEFAULT_EXCLUDE_FILES,
      remoteZipPath: remoteZip,
    },
    steps: [
      {
        name: 'Backup current code (keep 3)',
        command: [
          'BACKUP_DIR=/var/www/annpriya/staging_backup_$(date +%Y%m%d_%H%M%S)',
          'if [ -d backend ]; then sudo cp -r . "$BACKUP_DIR" && echo "backup: $BACKUP_DIR"; else echo "first deploy, no backup"; fi',
          `sudo find /var/www/annpriya/ -maxdepth 1 -type d -name 'staging_backup_*' | sort -r | tail -n +4 | while read d; do echo "removing old backup: $d"; sudo rm -rf "$d"; done`,
        ].join('\n'),
      },
      {
        name: 'Extract bundle + verify',
        command: [
          '# unzip warns (exit 1) on some entries; accept <=1, real failures are >=2',
          `sudo unzip -o ~/vision-deploy.zip -d ${workingDir} > /dev/null 2>/tmp/unzip-warn.log || [ $? -le 1 ]`,
          'sudo chown -R ubuntu:ubuntu /var/www/annpriya/',
          'sudo chmod -R 755 /var/www/annpriya/',
          'test -d backend/src/common || { echo "ERROR: backend/src/common missing after extract"; exit 1; }',
          'echo "extract OK"',
        ].join('\n'),
      },
      {
        name: 'Backend install',
        command: 'cd backend && npm install --no-audit --no-fund',
      },
      {
        name: 'Backend build',
        command: 'cd backend && npm run build',
      },
      {
        name: 'Restart backend (PM2)',
        command: [
          'PM2_APP=annpriya-backend',
          'pm2 flush "$PM2_APP" > /dev/null 2>&1 || true',
          'if pm2 describe "$PM2_APP" > /dev/null 2>&1; then pm2 restart "$PM2_APP" --update-env; else pm2 start backend/dist/main.js --name "$PM2_APP" --cwd backend/ --env production; fi',
          '# remove the known cloned-from-prod orphan that can\'t bind the port',
          'pm2 describe annpriya-staging-backend > /dev/null 2>&1 && pm2 delete annpriya-staging-backend || true',
          'pm2 save > /dev/null',
          'echo "pm2 restart OK"',
        ].join('\n'),
      },
      {
        name: 'Frontend install',
        command: 'cd front_end && yarn install --frozen-lockfile',
      },
      {
        name: 'Frontend build + verify',
        command: [
          'cd front_end && yarn build',
          'test -f build/index.html || { echo "ERROR: front_end/build/index.html missing"; exit 1; }',
          'echo "frontend build OK"',
        ].join('\n'),
      },
      {
        name: 'Reload nginx',
        command: 'sudo nginx -t && sudo systemctl reload nginx && echo "nginx reloaded"',
      },
      {
        name: 'Backend smoke test',
        command:
          'CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:8001/api/products || echo 000); echo "backend /api/products -> HTTP $CODE"; [ "$CODE" = "200" ] || [ "$CODE" = "401" ]',
      },
      {
        name: 'Cleanup',
        command: 'rm -f ~/vision-deploy.zip && echo "cleanup done"',
      },
    ],
    healthUrl: 'https://staging.bookmyfresh.com',
  };
}
