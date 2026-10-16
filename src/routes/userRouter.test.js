const request = require('supertest');
const app = require('../service');

test('list users unauthorized', async () => {
    const listUsersRes = await request(app).get('/api/user');
    expect(listUsersRes.status).toBe(401);
});

test('list users', async () => {
    const [user, userToken] = await registerUser(request(app));
    const listUsersRes = await request(app)
        .get('/api/user')
        .set('Authorization', 'Bearer ' + userToken);
    expect(listUsersRes.status).toBe(200);
});

async function registerUser(service) {
    const testUser = {
        name: 'pizza diner',
        email: `${randomName()}@test.com`,
        password: 'a',
    };
    const registerRes = await service.post('/api/auth').send(testUser);
    registerRes.body.user.password = testUser.password;

    return [registerRes.body.user, registerRes.body.token];
}

function randomName() {
    return Math.random().toString(36).substring(2, 12);
}