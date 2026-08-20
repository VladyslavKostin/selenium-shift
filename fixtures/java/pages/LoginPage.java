package shop.tests.pages;

import java.time.Duration;
import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.WebDriverWait;

public class LoginPage {
    private final WebDriver driver;
    private final WebDriverWait wait;

    public LoginPage(WebDriver driver) {
        this.driver = driver;
        this.wait = new WebDriverWait(driver, Duration.ofSeconds(10));
    }

    public void open(String url) {
        driver.get(url);
    }

    public void login(String user, String password) {
        driver.findElement(By.id("username")).sendKeys(user);
        driver.findElement(By.id("password")).sendKeys(password);
        driver.findElement(By.cssSelector("button[type=submit]")).click();
    }

    public boolean isLoggedIn() {
        return driver.findElement(By.cssSelector(".account-menu")).isDisplayed();
    }

    public String errorMessage() {
        return driver.findElement(By.className("error-banner")).getText();
    }

    public String title() {
        return driver.getTitle();
    }

    public void slowCheckout() throws InterruptedException {
        driver.findElement(By.xpath("//button[text()='Checkout']")).click();
        Thread.sleep(2000);
    }
}
