import data from "./data.json" with { type: "json" };

const companyAddingButton = document.getElementById("add-company-field");

companyAddingButton.addEventListener("click", () => {
	const jsonObject = data;

	const company = {
		id: "TEST",
		name: "test names"
	};
	
	jsonObject.push(company);
	
});