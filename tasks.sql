-- Run once in phpMyAdmin (SQL tab, with your database selected)
CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(80) NOT NULL,
  description VARCHAR(160) NOT NULL DEFAULT '',
  url VARCHAR(255) NOT NULL,              -- https://t.me/... link to open
  reward BIGINT NOT NULL,                 -- micro-USDT (0.002 USDT = 2000)
  wait_seconds INT NOT NULL DEFAULT 30,
  kind VARCHAR(10) NOT NULL DEFAULT 'bot',-- bot | channel (channel = membership is checked)
  chat VARCHAR(64) NULL,                  -- channel tasks only: @channelusername
  active TINYINT NOT NULL DEFAULT 1,
  created_at INT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  task_id INT NOT NULL,
  token CHAR(32) NOT NULL,
  created_at INT NOT NULL,
  used TINYINT NOT NULL DEFAULT 0,
  KEY idx_user_task (user_id, task_id, used)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS task_claims (
  user_id BIGINT NOT NULL,
  task_id INT NOT NULL,
  amount BIGINT NOT NULL,
  created_at INT NOT NULL,
  PRIMARY KEY (user_id, task_id)          -- one reward per user per task
) ENGINE=InnoDB;
