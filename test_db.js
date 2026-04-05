require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const d = await mongoose.connection.db.collection('universities').find({ name: /Jamshoro/i }).toArray();
  console.log(d.map(x=>x.thumbnail));
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
