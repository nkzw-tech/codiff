ALTER TABLE `account`
  ADD COLUMN `issuer` text DEFAULT 'local:oauth:github' NOT NULL;

CREATE UNIQUE INDEX `account_issuer_accountId_uidx`
  ON `account` (`issuer`, `accountId`);
