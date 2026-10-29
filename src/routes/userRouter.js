const express = require('express');
const { asyncHandler, StatusCodeError } = require('../endpointHelper.js');
const { DB, Role } = require('../database/database.js');
const { authRouter, setAuth } = require('./authRouter.js');

const userRouter = express.Router();

userRouter.docs = [
  {
    method: 'GET',
    path: '/api/user?page=1&limit=10&name=*',
    requiresAuth: true,
    description: 'Gets a list of users',
    example: `curl 'localhost:3000/api/user?page=1&limit=10&name=*' -H 'Authorization: Bearer tttttt'`,
    response: {
      users: [
        {
          id: 1,
          name: '常用名字',
          email: 'a@jwt.com',
        },
      ],
      more: true,
    },
  },
  {
    method: 'GET',
    path: '/api/user/me',
    requiresAuth: true,
    description: 'Get authenticated user',
    example: `curl -X GET localhost:3000/api/user/me -H 'Authorization: Bearer tttttt'`,
    response: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] },
  },
  {
    method: 'PUT',
    path: '/api/user/:userId',
    requiresAuth: true,
    description: 'Update user',
    example: `curl -X PUT localhost:3000/api/user/1 -d '{"name":"常用名字", "email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json' -H 'Authorization: Bearer tttttt'`,
    response: { user: { id: 1, name: '常用名字', email: 'a@jwt.com', roles: [{ role: 'admin' }] }, token: 'tttttt' },
  },
  {
    method: 'DELETE',
    path: '/api/user/:userId',
    requiresAuth: true,
    description: 'Delete a user (admin only)',
    example: `curl -X DELETE localhost:3000/api/user/2 -H 'Authorization: Bearer tttttt'`,
    response: { message: 'user deleted' },
  },
];

// getUser
userRouter.get(
  '/me',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    res.json(req.user);
  })
);

// updateUser
userRouter.put(
  '/:userId',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    const userId = Number(req.params.userId);
    const user = req.user;
    if (user.id !== userId && !user.isRole(Role.Admin)) {
      return res.status(403).json({ message: 'unauthorized' });
    }

    const updatedUser = await DB.updateUser(userId, name, email, password);
    const auth = await setAuth(updatedUser);
    res.json({ user: updatedUser, token: auth });
  })
);

// deleteUser
userRouter.delete(
  '/:userId',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    if (!req.user.isRole(Role.Admin)) {
      throw new StatusCodeError('unable to delete a user', 403);
    }

    const userId = Number(req.params.userId);
    if (!/^[1-9]\d*$/.test(req.params.userId) || !Number.isSafeInteger(userId)) {
      throw new StatusCodeError('userId must be a positive integer', 400);
    }

    await DB.deleteUser(userId);
    res.json({ message: 'user deleted' });
  })
);

// listUsers
userRouter.get(
  '/',
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    const parsePositiveInteger = (value, defaultValue, parameter) => {
      if (value === undefined) return defaultValue;
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
        throw new StatusCodeError(`${parameter} must be a positive integer`, 400);
      }

      const parsedValue = Number(value);
      if (!Number.isSafeInteger(parsedValue)) {
        throw new StatusCodeError(`${parameter} must be a positive integer`, 400);
      }
      return parsedValue;
    };

    const page = parsePositiveInteger(req.query.page, 1, 'page');
    const limit = parsePositiveInteger(req.query.limit, 10, 'limit');
    if (limit > 100) {
      throw new StatusCodeError('limit cannot be greater than 100', 400);
    }

    const name = req.query.name ?? '*';
    if (typeof name !== 'string') {
      throw new StatusCodeError('name must be a string', 400);
    }

    const result = await DB.getUsers(page, limit, name);
    res.json(result);
  }),
);

module.exports = userRouter;
