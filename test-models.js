async function test() {
  try {
    const res = await fetch('https://api.deepseek.com/models', {
      redirect: 'error',
      headers: {
        'Authorization': `Bearer sk-66e38cdf2a464659b9b5ac4e590a97b7`
      }
    });
    console.log('Status:', res.status);
    const data = await res.json();
    console.log('Data:', JSON.stringify(data, null, 2));
  } catch(e) {
    console.error('Error:', e);
  }
}
test();
