jest.mock('../config.js', () => ({ db: { connection: { database: 'pizza' } } }));
jest.mock('../logger.js', () => ({ dbLogger: jest.fn() }));
jest.mock('mysql2/promise', () => ({ createConnection: jest.fn().mockResolvedValue({
  execute: jest.fn().mockResolvedValue([[{ SCHEMA_NAME: 'pizza' }]]),
  query: jest.fn().mockResolvedValue([[]]),
  end: jest.fn(),
}) }));

const mysql = require('mysql2/promise');
const logger = require('../logger.js');
const { DB } = require('./database.js');

beforeEach(async () => {
  await DB.initialized;
  jest.clearAllMocks();
});

test('logs SQL without parameters and preserves query results', async () => {
  const rows = [{ id: 42 }];
  const connection = { execute: jest.fn().mockResolvedValue([rows]) };
  const sql = 'SELECT id FROM auth WHERE token=?';
  await expect(DB.query(connection, sql, ['private-token'])).resolves.toBe(rows);
  expect(connection.execute).toHaveBeenCalledWith(sql, ['private-token']);
  expect(logger.dbLogger).toHaveBeenCalledTimes(1);
  expect(logger.dbLogger).toHaveBeenCalledWith(sql);
});

test('logs failed queries and preserves the database error', async () => {
  const error = new Error('database unavailable');
  const connection = { execute: jest.fn().mockRejectedValue(error) };
  await expect(DB.query(connection, 'SELECT 1')).rejects.toBe(error);
  expect(logger.dbLogger).toHaveBeenCalledTimes(1);
  expect(logger.dbLogger).toHaveBeenCalledWith('SELECT 1');
});

test('logs ID lookups and schema checks through the shared helper', async () => {
  const connection = { execute: jest.fn().mockResolvedValue([[{ id: 42 }]]) };
  await expect(DB.getID(connection, 'email', 'private@example.test', 'user')).resolves.toBe(42);
  expect(logger.dbLogger).toHaveBeenLastCalledWith('SELECT id FROM user WHERE email=?');
  await expect(DB.checkDatabaseExists(connection)).resolves.toBe(true);
  expect(logger.dbLogger).toHaveBeenLastCalledWith('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?');
});

test('logs database selection and initialization while retaining text queries', async () => {
  const connection = await DB._getConnection();
  expect(logger.dbLogger).toHaveBeenCalledWith('USE pizza');
  expect(connection.query).toHaveBeenCalledWith('USE pizza', undefined);
  jest.clearAllMocks();
  await DB.initializeDatabase();
  expect(logger.dbLogger).toHaveBeenCalledWith('CREATE DATABASE IF NOT EXISTS pizza');
  expect(logger.dbLogger).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS'));
  expect(logger.dbLogger).toHaveBeenCalledTimes(connection.execute.mock.calls.length + connection.query.mock.calls.length);
  expect(mysql.createConnection).toHaveBeenCalledTimes(1);
});
