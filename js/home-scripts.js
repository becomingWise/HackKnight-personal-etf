// Started with a gemini prompt

const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('userInput');
const sendButton = document.getElementById('sendButton');

// Function to append a message to the chat container
//function appendMessage(text, sender) {
//	const messageDiv = document.createElement('div');
//	messageDiv.classList.add('message', sender);
//	messageDiv.textContent = text;
//	chatMessages.appendChild(messageDiv);
//	// Auto-scroll to the bottom
//	chatMessages.scrollTop = chatMessages.scrollHeight;
//}

// Function to handle sending message to the API
async function handleSendMessage() {
	const text = userInput.value.trim();
	if (!text) return;

	// 1. Display user message
	//appendMessage(text, 'user');
	//userInput.value = '';

	// Optional: Add a temporary "Typing..." state
	//const loadingId = 'loading-' + Date.now();
	//const loadingDiv = document.createElement('div');
	//loadingDiv.classList.add('message', 'bot');
	//loadingDiv.textContent = 'Thinking...';
	//loadingDiv.id = loadingId;
	////chatMessages.appendChild(loadingDiv);
	//chatMessages.scrollTop = chatMessages.scrollHeight;

	try {
		// 2. Make the fetch request to your API / endpoint
		// Replace with your actual endpoint URL and payload structure
		const response = await fetch('https://api.your-ai-provider.com/v1/chat', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Bearer YOUR_API_KEY'
			},
			body: JSON.stringify({
				prompt: text
			})
		});

		if (!response.ok) throw new Error('Network response was not ok');

		const data = await response.json();

		// Remove loading indicator
		//document.getElementById(loadingId).remove();

		// 3. Display the AI's response (adjust data.reply based on your API schema)
		//const botReply = data.reply || "Sorry, I didn't get a valid response.";
		//appendMessage(botReply, 'bot');

	} catch (error) {
		console.error('Error:', error);
		//document.getElementById(loadingId).remove();
		//appendMessage('Error: Failed to connect to the server.', 'bot');
	}
}

// Event listeners
sendButton.addEventListener('click', async () => {
	console.log("click");
	await handleSendMessage();
    window.location.href = "./dashboard.html";
});
userInput.addEventListener('keydown', async (e) => {
	if (e.key === 'Enter') {
		console.log("enter");
		await handleSendMessage();
    	window.location.href = "./dashboard.html";
	}
});
