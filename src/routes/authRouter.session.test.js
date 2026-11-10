const jwt = require('jsonwebtoken');

jest.mock('../config.js', () => ({ jwtSecret: 'session-test-secret' }));
jest.mock('../database/database.js', () => ({ DB: { loginUser: jest.fn().mockResolvedValue() }, Role: {} }));
jest.mock('../metrics.js', () => ({ trackAuth: jest.fn() }));

const { setAuth } = require('./authRouter.js');
const { DB } = require('../database/database.js');

afterEach(() => jest.restoreAllMocks());

test('simultaneous logins for the same user create independent sessions', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1804800000000);
  const user = { id: 42, name: 'pizza diner', email: 'd@jwt.com', roles: [{ role: 'diner' }] };
  const first = await setAuth(user);
  const second = await setAuth(user);

  expect(first).not.toBe(second);
  expect(jwt.verify(first, 'session-test-secret')).toMatchObject({ ...user, jti: expect.any(String) });
  expect(jwt.verify(second, 'session-test-secret')).toMatchObject({ ...user, jti: expect.any(String) });
  expect(DB.loginUser).toHaveBeenNthCalledWith(1, user.id, first);
  expect(DB.loginUser).toHaveBeenNthCalledWith(2, user.id, second);
});
