export function generateRandomID() {
	let titleId = '01';
	for (let i = 0; i < 10; i++) {
		let hex = Math.floor(Math.random() * Math.floor(15));
		switch (hex) {
			case 15:
				titleId += 'f';
				break;
			case 14:
				titleId += 'e';
				break;
			case 13:
				titleId += 'd';
				break;
			case 12:
				titleId += 'c';
				break;
			case 11:
				titleId += 'b';
				break;
			case 10:
				titleId += 'a';
				break;
			default:
				titleId += hex;
				break;
		}
	}
	titleId += '0000';
	return titleId;
}
