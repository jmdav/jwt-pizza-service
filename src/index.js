const logger = require('./logger.js');
logger.installProcessErrorLogging();
const app = require('./service.js');

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
