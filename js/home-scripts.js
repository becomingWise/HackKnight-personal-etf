// Started with a gemini prompt

const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('sendButton');

// Function to handle sending message to the API
async function handleSendMessage() {
	const text = userInput.value.trim();
	if (!text) return;

	//	try {
	//	// 2. Make the fetch request to your API / endpoint
	//	// Replace with your actual endpoint URL and payload structure
	//	//const response = await fetch('https://api.your-ai-provider.com/v1/chat', {
	//	//	method: 'POST',
	//	//	headers: {
	//	//		'Content-Type': 'application/json',
	//	//		'Authorization': 'Bearer YOUR_API_KEY'
	//	//	},
	//	//	body: JSON.stringify({
	//	//		prompt: text
	//	//	})
	//	//});

	//	if (!response.ok) throw new Error('Network response was not ok');

	//	const data = await response.json();


	//} catch (error) {
	//	console.error('Error:', error);
	//}
}

// Event listeners
sendButton.addEventListener('click', async () => {
	console.log("click");
	await handleSendMessage();
    //window.location.href = "./dashboard.html";
	window.location.href = "./dashboard.html?idea=" + encodeURIComponent(userInput.value.trim());
});
userInput.addEventListener('keydown', async (e) => {
	if (e.key === 'Enter') {
		if (userInput.value.trim().length > 0) {
			console.log("enter");
			await handleSendMessage();
    		//window.location.href = "./dashboard.html";
			window.location.href = "./dashboard.html?idea=" + encodeURIComponent(userInput.value.trim());
		}
	}
});
